/**
 * sign-lease-co-applicant -- Phase 3 + Phase 05
 *
 * Co-applicant counterpart to sign-lease.  Phase 05 adds:
 *   * per-IP and per-token rate limiting (20/hr/IP, 5/hr/token)
 *   * E-SIGN consent gating (412 if no recent consent on file)
 *   * structured token-error mapping (410 expired/revoked/used)
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/send-email.ts';
import { coApplicantSignedHtml } from '../_shared/email.ts';
import { getAdminEmails, getAdminUrl, getSiteUrl } from '../_shared/config.ts';

import { resolveLeaseTemplate, finalizeAndStorePdf } from '../_shared/lease-render.ts';
import { fetchAttachedAddenda } from '../_shared/lease-addenda.ts';
import { isDbRateLimited } from '../_shared/rate-limit.ts';
import { ESIGN_DISCLOSURE_VERSION } from '../_shared/esign-consent.ts';
import { mirrorAppToLease } from '../_shared/lease-mirror.ts';

const ADMIN_EMAILS = getAdminEmails();

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function logEmail(appId: string, type: string, recipient: string, status: string, provider = 'gas', errorMsg: string | null = null) {
  try { await supabase.from('email_logs').insert({ app_id: appId, type, recipient, status, provider, error_msg: errorMsg }); } catch (_) {}
}

function mapTokenError(message: string): { status: number; body: string; already_signed?: boolean } {
  if (/TOKEN_EXPIRED/.test(message))       return { status: 410, body: message.replace(/^TOKEN_EXPIRED:?\s*/, '') || 'This signing link has expired.' };
  if (/TOKEN_REVOKED/.test(message))       return { status: 410, body: message.replace(/^TOKEN_REVOKED:?\s*/, '') || 'This signing link has been revoked.' };
  if (/TOKEN_ALREADY_USED/.test(message))  return { status: 409, body: 'This lease has already been signed.', already_signed: true };
  if (/TOKEN_NOT_FOUND/.test(message))     return { status: 404, body: 'This signing link is not recognized.' };
  if (/TOKEN_WRONG_ROLE/.test(message))    return { status: 400, body: 'This signing link is for a different signer.' };
  if (/TOKEN_IP_MISMATCH/.test(message))   return { status: 403, body: 'This signing link can only be used from the original network.' };
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
  if (await isDbRateLimited(ip, 'sign-lease-co-applicant', 20, 60 * 60 * 1000)) {
    return jsonErr(429, 'Too many signing attempts from this network. Please wait an hour and try again.');
  }
  if (await isDbRateLimited(ip, 'sign-lease-co-applicant:tok:' + token.slice(0, 16), 5, 60 * 60 * 1000)) {
    return jsonErr(429, 'This signing link has been used too many times in the last hour. Please wait and retry.');
  }

  // Look up by co-applicant token
  const { data: preApp, error: preErr } = await supabase
    .from('applications')
    .select('id, app_id, first_name, last_name, property_address, lease_pdf_url, lease_template_version_id, has_co_applicant, tenant_signature')
    .eq('co_applicant_lease_token', token)
    .single();
  if (preErr || !preApp) {
    return jsonErr(400, 'This signing link is invalid or has already been used.');
  }
  if (!preApp.has_co_applicant) {
    return jsonErr(400, 'No co-applicant on this application.');
  }
  if (!preApp.tenant_signature) {
    return jsonErr(400, 'The primary applicant must sign first before the co-applicant can sign.');
  }

  // Pull co-applicant for email verification
  const { data: co } = await supabase
    .from('co_applicants').select('first_name, last_name, email')
    .eq('app_id', preApp.app_id).maybeSingle();
  if (!co?.email) {
    return jsonErr(400, 'Co-applicant record not found for this application.');
  }
  if (!applicant_email || applicant_email.trim().toLowerCase() !== co.email.toLowerCase()) {
    return jsonErr(403, 'The email you entered does not match our records. Please use the email the co-applicant was contacted at.');
  }

  // Phase 05 -- E-SIGN consent must be on file (separate from primary tenant's)
  const { data: hasConsent } = await supabase.rpc('has_recent_esign_consent', {
    p_app_id:  preApp.app_id,
    p_email:   co.email,
    p_version: ESIGN_DISCLOSURE_VERSION,
  });
  if (!hasConsent) {
    return jsonErr(412, 'E-SIGN consent has not been recorded for this signer. Please complete the consent step before signing.');
  }

  const { error: signErr } = await supabase.rpc('sign_lease_co_applicant', {
    p_token:           token,
    p_signature:       signature,
    p_ip_address:      ip,
    p_user_agent:      user_agent || '',
    p_signature_image: signature_image || null,
  });
  if (signErr) {
    const m = mapTokenError(signErr.message || '');
    if (m.already_signed) {
      const corsH = handleCors(req);
      const headers = { 'Content-Type': 'application/json', ...(corsH ? Object.fromEntries(corsH.headers) : {}) };
      return new Response(JSON.stringify({ error: m.body, already_signed: true }), { status: 409, headers });
    }
    return jsonErr(m.status, m.body);
  }

  const { data: appSigned } = await supabase
    .from('applications').select('*').eq('id', preApp.id).single();

  // Phase 10 -- mirror co-applicant signature into the lease row + advance lifecycle
  let mirroredLeaseId: string | null = null;
  if (appSigned) {
    const mir = await mirrorAppToLease(supabase, appSigned, 'co_applicant_signed');
    if (mir.ok) mirroredLeaseId = mir.lease_id;
    else console.error('mirrorAppToLease failed (non-fatal):', mir.error);
  }

  if (appSigned) {
    const tmpl = await resolveLeaseTemplate(supabase, appSigned);
    if (tmpl) {
      try {
        const attachedAddenda = await fetchAttachedAddenda(supabase, appSigned.app_id);
        const fin = await finalizeAndStorePdf({
          supabase,
          app_id:              appSigned.app_id,
          app:                 appSigned,
          templateText:        tmpl.template_body,
          templateVersionId:   tmpl.version_id,
          templateVersion:     tmpl.version_number || null,
          event:               'co_signed',
          createdBy:           co.email,
          addenda:             attachedAddenda,
          addendaAssetBaseUrl: getSiteUrl(),
          updateAppPointer:    true,
          certificate: {
            state_code:        appSigned.lease_state_code || null,
            edge_function_tag: 'sign-lease-co-applicant@phase10',
            site_url:          getSiteUrl(),
            signers: [
              {
                role:       'tenant',
                name:       appSigned.tenant_signature || `${appSigned.first_name || ''} ${appSigned.last_name || ''}`.trim(),
                email:      appSigned.email,
                signed_at:  appSigned.signature_timestamp || null,
                ip:         appSigned.lease_ip_address || null,
                user_agent: appSigned.lease_user_agent || null,
                has_image:  !!appSigned.tenant_signature_image,
              },
              {
                role:       'co_applicant',
                name:       signature,
                email:      co.email,
                signed_at:  appSigned.co_applicant_signature_timestamp || new Date().toISOString(),
                ip:         ip,
                user_agent: user_agent || null,
                has_image:  !!signature_image,
              },
            ],
          },
        });
        if (!fin.ok) console.error('PDF finalize failed:', fin.error);
      } catch (e) { console.error('PDF re-gen failed (non-fatal):', (e as Error).message); }
    }

    try {
      const coResult = await sendEmail({
        to:      co.email,
        subject: `\u{2705} Co-Applicant Signature Received -- Choice Properties (Ref: ${appSigned.app_id})`,
        html:    coApplicantSignedHtml(co.first_name || 'Co-Applicant', appSigned.property_address || '', appSigned.app_id),
      });
      await logEmail(appSigned.app_id, 'co_applicant_signed_confirm', co.email, coResult.ok ? 'sent' : 'failed', coResult.provider, coResult.ok ? null : (coResult.error || 'failed'));
    } catch (e) { console.error('Co-applicant confirm email failed:', (e as Error).message); }

    const adminSubject = `[Co-Applicant Signed] ${co.first_name || ''} ${co.last_name || ''} -- ${appSigned.app_id}`;
    const adminHtml = `<p><strong>Co-applicant signed</strong> by ${co.first_name || ''} ${co.last_name || ''} (${co.email})</p>
<p>Application: ${appSigned.app_id}<br>Property: ${appSigned.property_address}<br>Signed: ${new Date().toLocaleString('en-US')}</p>
<p>Status: <strong>${appSigned.lease_status}</strong> &middot; ready for management countersignature</p>
<p><a href="${getAdminUrl('/admin/leases.html')}">View in Admin Panel &rarr;</a></p>`;
    for (const adminEmail of ADMIN_EMAILS) {
      try {
        const adminResult = await sendEmail({ to: adminEmail, subject: adminSubject, html: adminHtml });
        await logEmail(appSigned.app_id, 'co_applicant_signed_admin', adminEmail, adminResult.ok ? 'sent' : 'failed', adminResult.provider, adminResult.ok ? null : (adminResult.error || 'failed'));
      } catch (e) { console.error('Admin notify failed:', (e as Error).message); }
    }

    try {
      await supabase.from('admin_actions').insert({
        action:      'co_applicant_signed_lease',
        target_type: 'application',
        target_id:   appSigned.app_id,
        metadata:    { app_id: appSigned.app_id, actor: co.email, has_image: !!signature_image },
      });
    } catch (_) {}
  }

  return jsonOk({ success: true, lease_id: mirroredLeaseId, message: 'Co-applicant lease signed successfully.' });
});
