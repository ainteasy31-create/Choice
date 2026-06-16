import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/send-email.ts';
import {
  statusUpdateHtml,
  moveinEmailHtml,
  holdingFeeRequestHtml,
  holdingFeeReceivedHtml,
  paymentConfirmedHtml,
  moveInPrepHtml,
  leaseSigningReminderHtml,
  leaseExpiryAlertHtml,
  adminReviewSummaryHtml,
  landlordAppStatusHtml,
  formatDate,
} from '../_shared/email.ts';
import { getAdminEmails, getAdminUrl, getTenantLoginUrl, getTenantPortalUrl, getSiteUrl } from '../_shared/config.ts';
import { generateMagicLoginUrl } from '../_shared/magic-login.ts';
import { sendLandlordEmail, getLandlordForProperty } from '../_shared/landlord-notify.ts';

const ADMIN_EMAILS = getAdminEmails();
const TENANT_PORTAL_URL = getTenantPortalUrl();

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function verifyAdmin(req: Request): Promise<{ ok: boolean; userEmail?: string }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false };
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false };
  const { data: role } = await supabase.from('admin_roles').select('id').eq('user_id', user.id).single();
  return { ok: !!role, userEmail: user.email };
}

async function logEmail(
  appId: string,
  _appDbId: string,
  type: string,
  recipient: string,
  status: string,
  provider = 'unknown',
  errorMsg: string | null = null,
) {
  try {
    await supabase.from('email_logs').insert({
      app_id: appId,
      type,
      recipient,
      status,
      provider,
      // Surface the underlying GAS / network error to the admin email-logs UI
      // so secret-mismatch / quota / rate-limit failures are visible without
      // having to scrape Edge Function logs. (E-2, 2026-04-28.)
      error_msg: errorMsg,
    });
  } catch (_) {}
}

async function logAdminAction(appId: string, action: string, actor: string) {
  try {
    await supabase.from('admin_actions').insert({
      action,
      target_type: 'application',
      target_id:   appId,
      metadata:    { app_id: appId, actor },
    });
  } catch (_) {}
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const auth = await verifyAdmin(req);
  if (!auth.ok) return jsonErr(401, 'Unauthorized');

  let body: {
    app_id: string;
    type: string;
    message?: string;
    fee_amount?: number;
    due_date?: string;
    payment_method?: string;
    transaction_ref?: string;
    amount_collected?: number;
  };
  try { body = await req.json(); } catch { return jsonErr(400, 'Invalid JSON body'); }

  const { app_id, type, message } = body;
  if (!app_id || !type) return jsonErr(400, 'Missing app_id or type');

  const { data: app, error: appErr } = await supabase
    .from('applications').select('*').eq('app_id', app_id).single();
  if (appErr || !app) return jsonErr(404, 'Application not found');

  const name  = app.first_name || 'Applicant';
  const prop  = app.property_address || 'your property';
  const actor = auth.userEmail || 'admin';
  const now   = new Date().toISOString();

  // One-click sign-in: every applicant-facing notification email's CTA drops
  // the recipient straight into /tenant/portal.html via /auth/callback.html.
  // Falls back automatically to the legacy login page if Supabase
  // auth.admin.generateLink ever fails so emails are never broken.
  const portalLink = app.email
    ? await generateMagicLoginUrl(supabase, app.email, { appId: app_id })
    : getTenantLoginUrl(app_id, undefined);
  // State code for e-sign legal text
  const stateCode = app.lease_state_code || 'MI';

  let subject        = '';
  let html           = '';
  let sendToAdmin    = false;

  // Phase 4A — internal admin review summary (for holding_fee_received)
  let sendAdminReview      = false;
  let adminReviewSubject   = '';
  let adminReviewHtml      = '';

  // ── Build subject + html per type ──────────────────────────────────────────

  if (type === 'approved') {
    subject = 'Your Application Has Been Approved — Choice Properties';
    html    = statusUpdateHtml(
      app_id,
      name,
      'approved',
      message,
      portalLink,
      prop,
      app.property_name || undefined,
      stateCode,
    );

  } else if (type === 'denied') {
    subject = 'An Update Regarding Your Rental Application — Choice Properties';
    html    = statusUpdateHtml(
      app_id,
      name,
      'denied',
      message,
      portalLink,
      prop,
      app.property_name || undefined,
      stateCode,
    );

  } else if (type === 'waitlisted') {
    subject = `Application Update — Waitlisted for ${prop.split(',')[0]} | Choice Properties (Ref: ${app_id})`;
    html    = statusUpdateHtml(
      app_id,
      name,
      'waitlisted',
      message,
      portalLink,
      prop,
      app.property_name || undefined,
      stateCode,
    );

  } else if (type === 'movein_confirmed') {
    const moveDate = app.move_in_date_actual ? formatDate(app.move_in_date_actual) : undefined;
    subject = `\u{2713} Move-In Confirmed — ${prop.split(',')[0]} | Choice Properties (Ref: ${app_id})`;
    html    = moveinEmailHtml(name, prop, moveDate, message, app_id);

    // FIX: persist move_in_status = 'confirmed' to DB
    await supabase.from('applications').update({
      move_in_status: 'confirmed',
      updated_at:     now,
    }).eq('app_id', app_id);

  } else if (type === 'holding_fee_request') {
    subject = `Action Required — Reserve Your Unit | ${prop.split(',')[0]} (Ref: ${app_id})`;

    // Pull applicant's payment method preferences from their application
    const payMethods = [
      app.primary_payment_method,
      app.alternative_payment_method,
      app.third_choice_payment_method,
    ].filter(Boolean) as string[];

    html = holdingFeeRequestHtml(
      name,
      prop,
      body.fee_amount ?? app.holding_fee_amount,
      body.due_date   ?? app.holding_fee_due_date,
      message,
      app_id,
      payMethods.length ? payMethods : undefined,
    );

    const update: Record<string, unknown> = {
      holding_fee_requested:    true,
      holding_fee_requested_at: now,
      updated_at:               now,
    };
    if (body.fee_amount != null) update.holding_fee_amount   = body.fee_amount;
    if (body.due_date)           update.holding_fee_due_date = body.due_date;
    await supabase.from('applications').update(update).eq('app_id', app_id);

  } else if (type === 'holding_fee_received') {
    subject = `\u{2713} Holding Fee Confirmed — ${prop.split(',')[0]} | Choice Properties (Ref: ${app_id})`;
    html    = holdingFeeReceivedHtml(
      name,
      prop,
      TENANT_PORTAL_URL,
      message,
      body.fee_amount ?? app.holding_fee_amount,
      undefined,
      app_id,
    );

    await supabase.from('applications').update({
      holding_fee_paid:    true,
      holding_fee_paid_at: now,
      updated_at:          now,
    }).eq('app_id', app_id);

    // Phase 4A — admin review summary
    sendAdminReview    = true;
    adminReviewSubject = `Holding Fee Received — Generate Lease for ${name} ${app.last_name || ''}`.trim();
    adminReviewHtml    = adminReviewSummaryHtml(
      app.first_name || '', app.last_name || '', app.email || '',
      app.phone || '', prop, app_id,
      body.fee_amount ?? app.holding_fee_amount,
      app,
    );

  } else if (type === 'payment_confirmed') {
    subject = `\u{2705} Payment Confirmed — ${prop.split(',')[0]} | Choice Properties (Ref: ${app_id})`;
    html    = paymentConfirmedHtml(
      name,
      prop,
      body.amount_collected ?? app.payment_amount_collected,
      body.payment_method   ?? app.payment_method_confirmed,
      body.transaction_ref  ?? app.payment_transaction_ref,
      message,
      app.phone || undefined,
      app_id,
    );

    // FIX: also update payment_status to 'paid' in DB
    const update: Record<string, unknown> = {
      payment_confirmed_at: now,
      payment_status:       'paid',
      updated_at:           now,
    };
    if (body.payment_method   != null) update.payment_method_confirmed  = body.payment_method;
    if (body.transaction_ref  != null) update.payment_transaction_ref   = body.transaction_ref;
    if (body.amount_collected != null) update.payment_amount_collected  = body.amount_collected;
    await supabase.from('applications').update(update).eq('app_id', app_id);

  } else if (type === 'move_in_prep') {
    subject = `Your Move-In Guide — ${prop.split(',')[0]} | Choice Properties (Ref: ${app_id})`;
    const leaseData = (app.monthly_rent || app.security_deposit || app.move_in_costs || app.lease_start_date) ? {
      rent:       app.monthly_rent     || undefined,
      deposit:    app.security_deposit || undefined,
      moveInCost: app.move_in_costs    || undefined,
      startDate:  app.lease_start_date || undefined,
    } : undefined;
    html = moveInPrepHtml(name, prop, message, app_id, leaseData);

  } else if (type === 'lease_signing_reminder') {
    subject = `Reminder — Lease Pending Signature | ${prop.split(',')[0]} (Ref: ${app_id})`;
    // FIX: build direct signing URL from stored token
    const signingUrl = app.tenant_sign_token
      ? `${getSiteUrl()}/lease-sign.html?token=${app.tenant_sign_token}`
      : undefined;
    html = leaseSigningReminderHtml(name, prop, TENANT_PORTAL_URL, message, app_id, signingUrl);

  } else if (type === 'lease_expiry_alert') {
    // FIX: use lease_sent_date (unsigned lease alert), with fallbacks
    const leaseEnd = app.lease_sent_date || app.lease_end_date || app.move_out_date;
    if (!leaseEnd) return jsonErr(400, 'No lease date on this application');
    subject     = `Unsigned Lease Alert — ${prop}`;
    // FIX: pass tenant phone so admin can text directly
    html        = leaseExpiryAlertHtml(name, prop, leaseEnd, app_id, app.email || '', app.phone || undefined);
    sendToAdmin = true;

  } else {
    return jsonErr(400, `Unsupported email type: "${type}". Supported: approved, denied, waitlisted, movein_confirmed, holding_fee_request, holding_fee_received, payment_confirmed, move_in_prep, lease_signing_reminder, lease_expiry_alert`);
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  try {
    const failures: string[] = [];
    if (sendToAdmin) {
      for (const adminEmail of ADMIN_EMAILS) {
        const result = await sendEmail({ to: adminEmail, subject, html });
        await logEmail(app_id, app.id, type, adminEmail, result.ok ? 'sent' : 'failed', result.provider, result.ok ? null : (result.error || 'send failed'));
        if (!result.ok) failures.push(`${adminEmail}: ${result.error || 'send failed'}`);
      }
    } else {
      const result = await sendEmail({ to: app.email, subject, html });
      await logEmail(app_id, app.id, type, app.email, result.ok ? 'sent' : 'failed', result.provider, result.ok ? null : (result.error || 'send failed'));
      if (!result.ok) failures.push(`${app.email}: ${result.error || 'send failed'}`);
    }

    // Phase 4A — send admin review summary alongside holding_fee_received
    if (sendAdminReview) {
      for (const adminEmail of ADMIN_EMAILS) {
        const result = await sendEmail({ to: adminEmail, subject: adminReviewSubject, html: adminReviewHtml });
        await logEmail(app_id, app.id, 'admin_review_summary', adminEmail, result.ok ? 'sent' : 'failed', result.provider, result.ok ? null : (result.error || 'admin review send failed'));
        if (!result.ok) failures.push(`${adminEmail}: ${result.error || 'admin review send failed'}`);
      }
    }

    if (failures.length) {
      return jsonErr(502, `Email send failed: ${failures.join('; ')}`);
    }

    await logAdminAction(app_id, `send_email_${type}`, actor);

    // Landlord notification for key lifecycle events
    if (type === 'approved' || type === 'denied' || type === 'waitlisted') {
      try {
        const applicantName = `${app.first_name || ''} ${app.last_name || ''}`.trim();
        const landlordInfo = await getLandlordForProperty(supabase, app.property_id);
        if (landlordInfo?.email) {
          const lStatus = type as 'approved' | 'denied' | 'waitlisted';
          await sendEmail({
            to: landlordInfo.email,
            subject: `Application ${type.charAt(0).toUpperCase() + type.slice(1)} — ${app.property_address || app_id}`,
            html: landlordAppStatusHtml(landlordInfo.contact_name || '', applicantName, app.property_address || '', lStatus, app_id, getAdminUrl('/admin/applications.html')),
          });
        }
      } catch (_) {}
    }
    if (type === 'movein_confirmed') {
      try {
        const landlordInfo = await getLandlordForProperty(supabase, app.property_id);
        if (landlordInfo?.email) {
          const moveDate = app.move_in_date_actual ? new Date(app.move_in_date_actual).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'To be confirmed';
          await sendEmail({
            to: landlordInfo.email,
            subject: `Move-In Confirmed — ${app.property_address || app_id}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
<h2 style="color:#1a5276">Move-In Date Confirmed</h2>
<p>Hi ${landlordInfo.contact_name || 'there'},</p>
<p>Move-in for <strong>${app.first_name || ''} ${app.last_name || ''}</strong> at <strong>${app.property_address || ''}</strong> has been confirmed for <strong>${moveDate}</strong>.</p>
<p>Reference: <code>${app_id}</code></p>
<p style="font-size:12px;color:#888">Choice Properties &middot; support@choiceproperties.com</p>
</div>`,
          });
        }
      } catch (_) {}
    }

    const recipient = sendToAdmin ? ADMIN_EMAILS.join(', ') : app.email;
    return jsonOk({ success: true, to: recipient, type });

  } catch (e) {
    await logEmail(app_id, app.id, type, sendToAdmin ? 'admin' : app.email, 'failed');
    return jsonErr(500, 'Email send failed: ' + (e as Error).message);
  }
});
