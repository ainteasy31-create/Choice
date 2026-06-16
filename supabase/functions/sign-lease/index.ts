import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';
import { sendEmail }                   from '../_shared/send-email.ts';
import { signedConfirmHtml, coApplicantInviteHtml, landlordTenantSignedHtml } from '../_shared/email.ts';
import { getAdminEmails, getAdminUrl, getSiteUrl }  from '../_shared/config.ts';
import { sendLandlordEmail } from '../_shared/landlord-notify.ts';
import { resolveLeaseTemplate, finalizeAndStorePdf } from '../_shared/lease-render.ts';
import { fetchAttachedAddenda, recordAddendaAcknowledgment } from '../_shared/lease-addenda.ts';
import { isDbRateLimited }             from '../_shared/rate-limit.ts';
import { ESIGN_DISCLOSURE_VERSION }    from '../_shared/esign-consent.ts';
import { mirrorAppToLease }            from '../_shared/lease-mirror.ts';

const ADMIN_EMAILS = getAdminEmails();

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function logEmail(appId: string, type: string, recipient: string, status: string, provider = 'gas', errorMsg: string | null = null) {
  try { await supabase.from('email_logs').insert({ app_id: appId, type, recipient, status, provider, error_msg: errorMsg }); } catch (_) {}
}

// Phase 05 -- map raw RPC error messages back to user-friendly HTTP errors.
// validate_signing_token raises with a structured MESSAGE (TOKEN_EXPIRED,
// TOKEN_REVOKED, TOKEN_ALREADY_USED, TOKEN_NOT_FOUND, TOKEN_WRONG_ROLE,
// TOKEN_IP_MISMATCH) and a human-readable DETAIL.  postgres-js surfaces
// both as `error.message` ("MESSAGE: DETAIL").
function mapTokenError(message: string): { status: number; body: string; already_signed?: boolean } {
  if (/TOKEN_EXPIRED/.test(message))       return { status: 410, body: message.replace(/^TOKEN_EXPIRED:?\s*/, '') || 'This signing link has expired.' };
  if (/TOKEN_REVOKED/.test(message))       return { status: 410, body: message.replace(/^TOKEN_REVOKED:?\s*/, '') || 'This signing link has been revoked.' };
  // 409 = already_signed — client treats this as success (idempotent double-click / network retry)
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

  // Phase 05 -- per-IP rate limit (20/hr) AND per-token rate limit (5/hr)
  if (await isDbRateLimited(ip, 'sign-lease', 20, 60 * 60 * 1000)) {
    return jsonErr(429, 'Too many signing attempts from this network. Please wait an hour and try again.');
  }
  // Per-token: reuse the rate_limit_log table by namespacing the endpoint
  // with the first 16 chars of the token.  This stops brute-force replays.
  if (await isDbRateLimited(ip, 'sign-lease:tok:' + token.slice(0, 16), 5, 60 * 60 * 1000)) {
    return jsonErr(429, 'This signing link has been used too many times in the last hour. Please wait and retry.');
  }

  // Identity pre-check by token
  const { data: preApp, error: preErr } = await supabase
    .from('applications')
    .select('id, app_id, email, first_name, last_name, property_address, lease_pdf_url, lease_template_version_id, has_co_applicant')
    .eq('tenant_sign_token', token)
    .single();
  if (preErr || !preApp) {
    return jsonErr(400, 'This signing link is invalid or has already been used.');
  }
  if (!applicant_email || applicant_email.trim().toLowerCase() !== (preApp.email || '').toLowerCase()) {
    return jsonErr(403, 'The email you entered does not match our records. Please use the same email address you applied with.');
  }

  // Phase 05 -- E-SIGN consent must be on file before this signer can sign
  const { data: hasConsent } = await supabase.rpc('has_recent_esign_consent', {
    p_app_id:  preApp.app_id,
    p_email:   preApp.email,
    p_version: ESIGN_DISCLOSURE_VERSION,
  });
  if (!hasConsent) {
    return jsonErr(412, 'E-SIGN consent has not been recorded for this signer. Please complete the consent step before signing.');
  }

  // DB sign (with token validation/consume in the RPC)
  const { error: signErr } = await supabase.rpc('sign_lease_tenant', {
    p_token:           token,
    p_signature:       signature,
    p_ip_address:      ip,
    p_user_agent:      user_agent || '',
    p_signature_image: signature_image || null,
  });
  if (signErr) {
    const m = mapTokenError(signErr.message || '');
    // 409 = already_signed: return extra flag so the client can show success
    // instead of an error on network-retry or accidental double-click.
    if (m.already_signed) {
      const corsH = handleCors(req);
      const headers = { 'Content-Type': 'application/json', ...(corsH ? Object.fromEntries(corsH.headers) : {}) };
      return new Response(JSON.stringify({ error: m.body, already_signed: true }), { status: 409, headers });
    }
    return jsonErr(m.status, m.body);
  }

  // ----- Phase 04: per-addendum acknowledgment -----
  try {
    const ackRes = await recordAddendaAcknowledgment(supabase, preApp.app_id, {
      role:       'tenant',
      typed_name: signature,
      ip,
      user_agent: user_agent || '',
      initials:   null,
    });
    if (!ackRes.ok) console.warn('[sign-lease] addenda ack failed:', ackRes.error);
  } catch (e) {
    console.warn('[sign-lease] addenda ack threw:', (e as Error).message);
  }

  // Reload after signing
  const { data: appSigned } = await supabase
    .from('applications').select('*').eq('id', preApp.id).single();

  // Phase 10 -- mirror tenant signature into the lease row + advance lifecycle
  let mirroredLeaseId: string | null = null;
  if (appSigned) {
    const mir = await mirrorAppToLease(supabase, appSigned, 'tenant_signed');
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
          event:               'tenant_signed',
          createdBy:           appSigned.email,
          addenda:             attachedAddenda,
          addendaAssetBaseUrl: getSiteUrl(),
          updateAppPointer:    true,
          certificate: {
            state_code:        appSigned.lease_state_code || null,
            edge_function_tag: 'sign-lease@phase10',
            site_url:          getSiteUrl(),
            signers: [{
              role:           'tenant',
              name:           signature,
              email:          appSigned.email,
              signed_at:      appSigned.signature_timestamp || new Date().toISOString(),
              ip:             ip,
              user_agent:     user_agent || null,
              has_image:      !!signature_image,
            }],
          },
        });
        if (!fin.ok) console.error('PDF finalize failed:', fin.error);
      } catch (e) { console.error('PDF re-gen failed (non-fatal):', (e as Error).message); }
    }

    if (appSigned.has_co_applicant && appSigned.co_applicant_lease_token) {
      try {
        const { data: co } = await supabase
          .from('co_applicants').select('first_name, last_name, email')
          .eq('app_id', appSigned.app_id).maybeSingle();
        if (co?.email) {
          const signingUrl = `${getSiteUrl()}/lease-sign.html?token=${appSigned.co_applicant_lease_token}`;
          const coResult = await sendEmail({
            to:      co.email,
            subject: `\u{1F4DD} Your Co-Applicant Lease is Ready to Sign - Choice Properties (Ref: ${appSigned.app_id})`,
            html:    coApplicantInviteHtml(
              co.first_name || 'Co-Applicant',
              `${appSigned.first_name || ''} ${appSigned.last_name || ''}`.trim() || 'the primary applicant',
              appSigned.property_address || '',
              signingUrl,
              appSigned.app_id,
            ),
          });
          await logEmail(appSigned.app_id, 'co_applicant_invite', co.email, coResult.ok ? 'sent' : 'failed', coResult.provider, coResult.ok ? null : (coResult.error || 'failed'));
        }
      } catch (e) { console.error('Co-applicant invite email failed (non-fatal):', (e as Error).message); }
    }

    try {
      const leaseData = (appSigned.lease_start_date || appSigned.monthly_rent || appSigned.move_in_costs) ? {
        startDate:   appSigned.lease_start_date || undefined,
        endDate:     appSigned.lease_end_date   || undefined,
        rent:        appSigned.monthly_rent     || undefined,
        moveInCost:  appSigned.move_in_costs    || undefined,
      } : undefined;
      const tenantResult = await sendEmail({
        to:      appSigned.email,
        subject: `\u{1F389} Lease Signed - Welcome to Choice Properties (Ref: ${appSigned.app_id})`,
        html:    signedConfirmHtml(appSigned.first_name || 'Applicant', appSigned.property_address || '', appSigned.app_id, leaseData),
      });
      await logEmail(appSigned.app_id, 'lease_signed_confirm', appSigned.email, tenantResult.ok ? 'sent' : 'failed', tenantResult.provider, tenantResult.ok ? null : (tenantResult.error || 'failed'));
    } catch (e) { console.error('Tenant confirm email failed:', (e as Error).message); }

    // Landlord notification — tenant has signed, awaiting countersignature
    try {
      const tenantName = `${appSigned.first_name || ''} ${appSigned.last_name || ''}`.trim();
      await sendLandlordEmail(
        supabase,
        appSigned.property_id,
        `Lease Signed — ${appSigned.property_address || appSigned.app_id}`,
        landlordTenantSignedHtml('', tenantName, appSigned.property_address || '', appSigned.app_id, getAdminUrl('/admin/leases.html')),
      );
    } catch (_) {}

    const adminSubject = `[Lease Signed] ${appSigned.first_name || ''} ${appSigned.last_name || ''} - ${appSigned.app_id}`;
    const adminHtml = `<p><strong>Lease signed</strong> by ${appSigned.first_name || ''} ${appSigned.last_name || ''} (${appSigned.email})</p>
<p>Application: ${appSigned.app_id}<br>Property: ${appSigned.property_address}<br>Signed: ${new Date().toLocaleString('en-US')}</p>
<p>Status: <strong>${appSigned.lease_status}</strong>${appSigned.has_co_applicant ? ' &middot; co-applicant invited to sign' : ''}</p>
<p><a href="${getAdminUrl('/admin/leases.html')}">View in Admin Panel &rarr;</a></p>`;

    for (const adminEmail of ADMIN_EMAILS) {
      try {
        const adminResult = await sendEmail({ to: adminEmail, subject: adminSubject, html: adminHtml });
        await logEmail(appSigned.app_id, 'lease_signed_admin', adminEmail, adminResult.ok ? 'sent' : 'failed', adminResult.provider, adminResult.ok ? null : (adminResult.error || 'failed'));
      } catch (e) { console.error('Admin notify failed:', (e as Error).message); }
    }

    try {
      await supabase.from('admin_actions').insert({
        action:      'tenant_signed_lease',
        target_type: 'application',
        target_id:   appSigned.app_id,
        metadata:    { app_id: appSigned.app_id, actor: appSigned.email, has_image: !!signature_image },
      });
    } catch (_) {}
  }

  return jsonOk({ success: true, lease_id: mirroredLeaseId, message: 'Lease signed successfully.' });
});
