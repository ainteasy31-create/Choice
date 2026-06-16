/**
 * resend-signing-link -- Phase 05 -- ADMIN ONLY
 *
 * Mints a fresh signing token for an existing application (tenant or
 * co-applicant) or amendment and emails the new signing URL to the signer.
 * Any existing active token for the same (app_id, role[, amendment_id])
 * is automatically revoked by reissue_signing_token, so the old link
 * dies the moment this one is created.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/send-email.ts';
import { signingEmailHtml, coApplicantInviteHtml } from '../_shared/email.ts';
import { getSiteUrl } from '../_shared/config.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function logEmail(appId: string, type: string, recipient: string, status: string, provider = 'gas', errorMsg: string | null = null) {
  try { await supabase.from('email_logs').insert({ app_id: appId, type, recipient, status, provider, error_msg: errorMsg }); } catch (_) {}
}

async function verifyAdmin(req: Request): Promise<{ ok: boolean; userEmail?: string; error?: string }> {
  const auth = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!auth) return { ok: false, error: 'Missing authorization header' };
  const { data: { user }, error } = await supabase.auth.getUser(auth);
  if (error || !user) return { ok: false, error: 'Invalid or expired token' };
  const { data: role } = await supabase.from('admin_roles').select('id').eq('user_id', user.id).single();
  if (!role) return { ok: false, error: 'Not an admin' };
  return { ok: true, userEmail: user.email };
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const auth = await verifyAdmin(req);
  if (!auth.ok) return jsonErr(401, auth.error!);

  let body: {
    app_id:         string;
    role:           'tenant' | 'co_applicant' | 'amendment';
    amendment_id?:  string;
    send_email?:    boolean;
  };
  try { body = await req.json(); } catch { return jsonErr(400, 'Invalid JSON body'); }
  const { app_id, role, amendment_id } = body;
  const sendNow = body.send_email !== false;

  if (!app_id)                                        return jsonErr(400, 'Missing app_id');
  if (!role)                                          return jsonErr(400, 'Missing role');
  if (!['tenant','co_applicant','amendment'].includes(role)) return jsonErr(400, 'Invalid role');
  if (role === 'amendment' && !amendment_id)          return jsonErr(400, 'amendment_id required when role=amendment');

  // Mint fresh token (revokes any prior active one)
  const { data: newTokenRaw, error: rpcErr } = await supabase.rpc('reissue_signing_token', {
    p_app_id:       app_id,
    p_role:         role,
    p_by:           auth.userEmail || 'admin',
    p_amendment_id: amendment_id || null,
  });
  if (rpcErr || !newTokenRaw) return jsonErr(500, 'Reissue failed: ' + (rpcErr?.message || 'unknown'));
  const newToken = String(newTokenRaw);

  // Build signing URL
  const signingUrl = `${getSiteUrl()}/lease-sign.html?` +
    (role === 'amendment' ? `amendment_token=${newToken}` : `token=${newToken}`);

  // Look up app + signer details for the email
  const { data: app } = await supabase
    .from('applications')
    .select('first_name, last_name, email, property_address, has_co_applicant')
    .eq('app_id', app_id)
    .single();

  let toEmail = '';
  let toName  = '';
  if (role === 'tenant') {
    toEmail = app?.email || '';
    toName  = app?.first_name || 'Applicant';
  } else if (role === 'co_applicant') {
    const { data: co } = await supabase
      .from('co_applicants').select('first_name, last_name, email')
      .eq('app_id', app_id).maybeSingle();
    toEmail = co?.email || '';
    toName  = co?.first_name || 'Co-Applicant';
  } else {
    toEmail = app?.email || '';
    toName  = app?.first_name || 'Applicant';
  }

  let emailed = false;
  if (sendNow && toEmail) {
    try {
      const subject = role === 'co_applicant'
        ? `\u{1F4DD} New Co-Applicant Signing Link -- Choice Properties (Ref: ${app_id})`
        : role === 'amendment'
        ? `\u{1F4DD} New Amendment Signing Link -- Choice Properties (Ref: ${app_id})`
        : `\u{1F4DD} New Lease Signing Link -- Choice Properties (Ref: ${app_id})`;
      const html = role === 'co_applicant'
        ? coApplicantInviteHtml(
            toName,
            `${app?.first_name || ''} ${app?.last_name || ''}`.trim() || 'the primary applicant',
            app?.property_address || '',
            signingUrl,
            app_id,
          )
        : signingEmailHtml(toName, app?.property_address || '', signingUrl, app_id);
      const resendResult = await sendEmail({ to: toEmail, subject, html });
      await logEmail(app_id, `resend_signing_link_${role}`, toEmail, resendResult.ok ? 'sent' : 'failed', resendResult.provider, resendResult.ok ? null : (resendResult.error || 'failed'));
      emailed = resendResult.ok;
    } catch (e) {
      console.error('resend-signing-link email failed:', (e as Error).message);
    }
  }

  try {
    await supabase.from('admin_actions').insert({
      action:      'signing_link_reissued',
      target_type: 'application',
      target_id:   app_id,
      metadata:    {
        actor:        auth.userEmail || 'admin',
        signer_role:  role,
        amendment_id: amendment_id || null,
        emailed,
        to_email:     toEmail || null,
      },
    });
  } catch (_) { /* non-fatal */ }

  return jsonOk({
    success:     true,
    new_token:   newToken,
    signing_url: signingUrl,
    emailed,
  });
});
