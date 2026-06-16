/**
 * sign-amendment -- Phase 4 + Phase 05
 * Tenant signs a lease amendment via single-use token from email.
 * Phase 05 adds per-IP and per-token rate limiting + E-SIGN consent gating.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/send-email.ts';
import { amendmentSignedHtml } from '../_shared/email.ts';
import { renderTemplate, createSupabasePartialResolver } from '../_shared/template-engine.ts';
import { buildLeaseRenderContext } from '../_shared/lease-context.ts';
import { getAdminEmails, getAdminUrl, getSiteUrl } from '../_shared/config.ts';
import { finalizeAndStorePdf } from '../_shared/lease-render.ts';
import { isDbRateLimited } from '../_shared/rate-limit.ts';
import { ESIGN_DISCLOSURE_VERSION } from '../_shared/esign-consent.ts';

const ADMIN_EMAILS = getAdminEmails();

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function logEmail(appId: string, type: string, recipient: string, status: string, provider = 'gas', errorMsg: string | null = null) {
  try { await supabase.from('email_logs').insert({ app_id: appId, type, recipient, status, provider, error_msg: errorMsg }); } catch (_) {}
}

function mapTokenError(message: string): { status: number; body: string } {
  if (/TOKEN_EXPIRED/.test(message))       return { status: 410, body: message.replace(/^TOKEN_EXPIRED:?\s*/, '') || 'This amendment link has expired.' };
  if (/TOKEN_REVOKED/.test(message))       return { status: 410, body: message.replace(/^TOKEN_REVOKED:?\s*/, '') || 'This amendment link has been revoked.' };
  if (/TOKEN_ALREADY_USED/.test(message))  return { status: 410, body: 'This amendment link has already been used.' };
  if (/TOKEN_NOT_FOUND/.test(message))     return { status: 404, body: 'This amendment link is not recognized.' };
  if (/TOKEN_WRONG_ROLE/.test(message))    return { status: 400, body: 'This link is for a different signer.' };
  if (/TOKEN_IP_MISMATCH/.test(message))   return { status: 403, body: 'This amendment link can only be used from the original network.' };
  return { status: 400, body: message || 'Signing failed. The link may have expired.' };
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  let body: {
    token: string;
    signature: string;
    signature_image?: string;
    applicant_email?: string;
    user_agent?: string;
  };
  try { body = await req.json(); } catch { return jsonErr(400, 'Invalid JSON body'); }

  const { token, signature, signature_image, applicant_email, user_agent } = body;
  if (!token)     return jsonErr(400, 'Missing token');
  if (!signature) return jsonErr(400, 'Missing signature');
  if (signature.trim().length < 5) {
    return jsonErr(400, 'Signature must be at least 5 characters. Please type your full legal name.');
  }

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';
  if (await isDbRateLimited(ip, 'sign-amendment', 20, 60 * 60 * 1000)) {
    return jsonErr(429, 'Too many signing attempts from this network. Please wait an hour and try again.');
  }
  if (await isDbRateLimited(ip, 'sign-amendment:tok:' + token.slice(0, 16), 5, 60 * 60 * 1000)) {
    return jsonErr(429, 'This amendment link has been used too many times in the last hour. Please wait and retry.');
  }

  // Look up amendment and parent app
  const { data: amend } = await supabase
    .from('lease_amendments').select('*').eq('signing_token', token).maybeSingle();
  if (!amend) return jsonErr(400, 'This signing link is invalid or has already been used.');
  if (amend.status === 'voided')  return jsonErr(410, 'This amendment has been voided.');
  if (amend.tenant_signature)     return jsonErr(410, 'This amendment has already been signed.');

  const { data: app } = await supabase
    .from('applications').select('*').eq('app_id', amend.app_id).single();
  if (!app) return jsonErr(404, 'Parent lease not found.');

  if (!applicant_email || applicant_email.trim().toLowerCase() !== (app.email || '').toLowerCase()) {
    return jsonErr(403, 'The email you entered does not match our records. Please use the same email address you applied with.');
  }

  // Phase 05 -- E-SIGN consent for amendments
  const { data: hasConsent } = await supabase.rpc('has_recent_esign_consent', {
    p_app_id:  app.app_id,
    p_email:   app.email,
    p_version: ESIGN_DISCLOSURE_VERSION,
  });
  if (!hasConsent) {
    return jsonErr(412, 'E-SIGN consent has not been recorded for this signer. Please complete the consent step before signing.');
  }

  const { error: signErr } = await supabase.rpc('sign_lease_amendment', {
    p_token:           token,
    p_signature:       signature,
    p_ip_address:      ip,
    p_user_agent:      user_agent || '',
    p_signature_image: signature_image || null,
  });
  if (signErr) {
    const m = mapTokenError(signErr.message || '');
    return jsonErr(m.status, m.body);
  }

  const now = new Date().toISOString();

  // Re-render addendum PDF including signature block
  // Phase 06: appends Certificate of Completion w/ tenant signer + QR.
  let amendmentPdfPath: string | null = null;
  try {
    const partials  = createSupabasePartialResolver(supabase);
    const innerBody = await renderTemplate(amend.body, buildLeaseRenderContext(app), { partials });
    const signedAddendum = `LEASE ADDENDUM -- ${amend.title}\n\n${innerBody}\n\n` +
      `This addendum modifies the lease for property: ${app.property_address}\n` +
      `Application: ${app.app_id}\n`;
    const appWithSig = {
      ...app,
      tenant_signature:        signature,
      tenant_signature_image:  signature_image || null,
      signature_timestamp:     now,
      lease_ip_address:        ip,
    };

    const fin = await finalizeAndStorePdf({
      supabase,
      app_id:              app.app_id,
      app:                 appWithSig,
      templateText:        signedAddendum,
      templateVersionId:   app.lease_template_version_id || null,
      templateVersion:     null,
      event:               'amended',
      amendmentId:         amend.id,
      createdBy:           app.email,
      partials,
      addendaAssetBaseUrl: getSiteUrl(),
      // NOT updating applications.lease_pdf_url -- amendments live on
      // lease_amendments.pdf_path, the parent lease pointer is unchanged.
      updateAppPointer:    false,
      certificate: {
        state_code:        app.lease_state_code || null,
        edge_function_tag: 'sign-amendment@phase10',
        site_url:          getSiteUrl(),
        signers: [{
          role:       'tenant',
          name:       signature,
          email:      app.email,
          signed_at:  now,
          ip:         ip,
          user_agent: user_agent || null,
          has_image:  !!signature_image,
        }],
      },
    });
    if (fin.ok && fin.storage_path) {
      amendmentPdfPath = fin.storage_path;
      await supabase.from('lease_amendments')
        .update({ pdf_path: fin.storage_path }).eq('id', amend.id);
    } else if (!fin.ok) {
      console.error('Amendment PDF finalize failed:', fin.error);
    }
  } catch (e) { console.error('Amendment PDF re-gen failed (non-fatal):', (e as Error).message); }
  void amendmentPdfPath;

  // Confirmation to tenant
  try {
    const tenantResult = await sendEmail({
      to:      app.email,
      subject: `\u{2705} Amendment Signed -- Choice Properties (Ref: ${app.app_id})`,
      html:    amendmentSignedHtml(app.first_name || 'Applicant', app.property_address || '', amend.title, app.app_id),
    });
    await logEmail(app.app_id, 'amendment_signed_confirm', app.email, tenantResult.ok ? 'sent' : 'failed', tenantResult.provider, tenantResult.ok ? null : (tenantResult.error || 'failed'));
  } catch (e) { console.error('Amendment confirm email failed:', (e as Error).message); }

  for (const adminEmail of ADMIN_EMAILS) {
    try {
      const adminResult = await sendEmail({
        to: adminEmail,
        subject: `[Amendment Signed] ${amend.title} -- ${app.app_id}`,
        html: `<p><strong>Lease amendment signed</strong> by ${app.first_name || ''} ${app.last_name || ''} (${app.email})</p>
<p>Application: ${app.app_id}<br>Amendment: ${amend.title} (${amend.kind})<br>Signed: ${new Date().toLocaleString('en-US')}</p>
<p><a href="${getAdminUrl('/admin/leases.html')}">View in Admin Panel &rarr;</a></p>`,
      });
      await logEmail(app.app_id, 'amendment_signed_admin', adminEmail, adminResult.ok ? 'sent' : 'failed', adminResult.provider, adminResult.ok ? null : (adminResult.error || 'failed'));
    } catch (_) {}
  }

  try {
    await supabase.from('admin_actions').insert({
      action:      'lease_amendment_signed',
      target_type: 'application',
      target_id:   app.app_id,
      metadata:    { amendment_id: amend.id, actor: app.email },
    });
  } catch (_) {}

  return jsonOk({ success: true, amendment_id: amend.id });
});
