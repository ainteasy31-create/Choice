import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/send-email.ts';
import { applicationConfirmationHtml, adminNotificationHtml, landlordNewApplicationHtml } from '../_shared/email.ts';
import { getAdminEmails, getAdminUrl, getTenantLoginUrl } from '../_shared/config.ts';
import { generateMagicLoginUrl } from '../_shared/magic-login.ts';
import { isDbRateLimited } from '../_shared/rate-limit.ts';
import { sendLandlordEmail, getLandlordForProperty } from '../_shared/landlord-notify.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const ADMIN_EMAILS = getAdminEmails();

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateAppId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `CP-${y}${m}${d}-${random}${ms}`;
}

function fv(val: FormDataEntryValue | string | null | undefined): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function fBool(val: FormDataEntryValue | string | null | undefined): boolean | null {
  const s = fv(val).toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(s)) return true;
  if (['false', 'no', '0', 'none', 'off'].includes(s)) return false;
  return null;
}

function fNum(val: FormDataEntryValue | string | null | undefined): number | null {
  // Strip everything except digits, one optional leading '-', and one decimal point.
  // Rejects malformed inputs like "1.2.3", "--5", "5-3" rather than silently coercing.
  const raw = fv(val);
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

const VALID_PAYMENT_STATUSES = new Set(['unpaid', 'paid', 'waived', 'refunded']);
function fPaymentStatus(val: FormDataEntryValue | string | null | undefined): string {
  const status = fv(val).toLowerCase();
  return VALID_PAYMENT_STATUSES.has(status) ? status : 'unpaid';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getClientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') || '';
  return (fwd.split(',')[0] || req.headers.get('cf-connecting-ip') || 'unknown').trim();
}

function ageInYears(dobStr: string): number | null {
  if (!dobStr) return null;
  const dob = new Date(dobStr);
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

async function logBotAttempt(ip: string, ua: string, reason: string, payloadHash?: string) {
  try {
    await supabase.from('bot_attempts').insert({
      ip: ip === 'unknown' ? null : ip,
      user_agent: ua || null,
      endpoint: 'receive-application',
      reason,
      payload_hash: payloadHash || null,
    });
  } catch (_) { /* swallow */ }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // ── GET: legacy verification endpoint ──────────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const path = url.searchParams.get('path');
    const email = fv(url.searchParams.get('email')).toLowerCase();

    if (path === 'checkRecentSubmission') {
      if (!email || !email.includes('@')) return jsonOk({ found: false });
      const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('applications')
        .select('app_id, created_at')
        .ilike('email', email)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error('Verify error:', JSON.stringify(error));
        return jsonErr(500, 'Failed to verify submission');
      }
      return jsonOk({ found: !!data, appId: data?.app_id || null });
    }

    return jsonErr(400, 'Unsupported verification request');
  }

  if (req.method !== 'POST') return jsonErr(405, 'Method not allowed');

  const ip = getClientIp(req);
  const ua = req.headers.get('user-agent') || '';

  // ── Per-IP rate limit (5 submissions / 60s) ───────────────────────────────
  if (await isDbRateLimited(ip, 'receive-application', 5, 60_000)) {
    return jsonErr(429, 'Too many submissions. Please wait a minute and try again.');
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let fields: Record<string, string> = {};
  const ct = req.headers.get('content-type') || '';

  try {
    if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const fd = await req.formData();
      for (const [key, value] of fd.entries()) {
        if (typeof value === 'string') fields[key] = value;
      }
    } else {
      fields = await req.json();
    }
  } catch {
    return jsonErr(400, 'Invalid request body');
  }

  // ── Honeypot: log + return success-shaped response so bots can't probe ────
  if (fields['_trap']) {
    await logBotAttempt(ip, ua, 'honeypot');
    return jsonOk({ success: true, message: 'Application received.', appId: 'HP-' + Date.now() });
  }

  // ── Required-field validation ─────────────────────────────────────────────
  const email     = fv(fields['Email']).toLowerCase();
  const firstName = fv(fields['First Name']);
  const lastName  = fv(fields['Last Name']);
  const dob       = fv(fields['DOB']);

  if (!email || !email.includes('@') || email.length > 254) {
    await logBotAttempt(ip, ua, 'invalid_email');
    return jsonErr(400, 'Valid email is required');
  }
  if (!firstName) return jsonErr(400, 'First name is required');

  // ── Server-side consent enforcement (cannot be bypassed from client) ──────
  const termsConsent = fv(fields['Terms Consent']) === 'yes'
                    || fBool(fields['Terms Consent']) === true
                    || fBool(fields['agreeTermsPrivacy']) === true;
  if (!termsConsent) {
    return jsonErr(400, 'You must accept the Terms & Privacy Policy to submit.');
  }

  // ── Server-side age 18+ check — primary applicant ────────────────────────
  const age = ageInYears(dob);
  if (age === null) return jsonErr(400, 'A valid date of birth is required.');
  if (age < 18)     return jsonErr(400, 'Applicants must be 18 years of age or older.');
  if (age > 120)    return jsonErr(400, 'Please enter a valid date of birth.');

  // ── Server-side age 18+ check — co-applicant (if present) ────────────────
  const hasCoApplicant = fBool(fields['Has Co-Applicant']) === true;
  const coDob = fv(fields['Co-Applicant DOB']);
  if (hasCoApplicant && coDob) {
    const coAge = ageInYears(coDob);
    if (coAge !== null && coAge < 18) {
      return jsonErr(400, 'Co-applicant must be 18 years of age or older.');
    }
    if (coAge !== null && coAge > 120) {
      return jsonErr(400, 'Please enter a valid date of birth for the co-applicant.');
    }
  }

  // ── Property is required, fee/rent/deposit must come from DB, never client ─
  const submittedPropertyId = fv(fields['Property ID']);
  if (!submittedPropertyId) {
    await logBotAttempt(ip, ua, 'no_property');
    return jsonErr(400, 'A property selection is required.');
  }

  const { data: prop, error: propErr } = await supabase
    .from('properties')
    .select('id, address, application_fee, monthly_rent, security_deposit, pets_allowed, smoking_allowed, status')
    .eq('id', submittedPropertyId)
    .maybeSingle();

  if (propErr) {
    console.error('Property lookup error:', JSON.stringify(propErr));
    return jsonErr(500, 'Could not validate property. Please retry.');
  }
  if (!prop) {
    await logBotAttempt(ip, ua, 'unknown_property');
    return jsonErr(400, 'Selected property is no longer available.');
  }
  if (prop.status && prop.status !== 'active' && prop.status !== 'pending') {
    return jsonErr(422, 'This property is no longer accepting applications.');
  }

  const enforcedFee     = typeof prop.application_fee   === 'number' ? prop.application_fee   : null;
  const enforcedRent    = typeof prop.monthly_rent      === 'number' ? prop.monthly_rent      : null;
  const enforcedDeposit = typeof prop.security_deposit  === 'number' ? prop.security_deposit  : null;
  const enforcedAddress = prop.address || fv(fields['Property Address']) || null;

  // Pets / smoking policy enforcement intentionally removed —
  // applicants may submit any answer for pets and smoking regardless of
  // the property's listed policy. Landlords review and decide on a
  // per-application basis instead of having submissions auto-rejected.

  // ── Idempotency: use client-supplied submission_uuid if present ───────────
  const clientUuid = fv(fields['submission_uuid']);
  const submissionUuid = (clientUuid && UUID_RE.test(clientUuid)) ? clientUuid.toLowerCase() : crypto.randomUUID();

  // Fast path: if this UUID was already inserted, return the existing app_id.
  {
    const { data: existing } = await supabase
      .from('applications')
      .select('app_id')
      .eq('submission_uuid', submissionUuid)
      .maybeSingle();
    if (existing?.app_id) {
      return jsonOk({ success: true, appId: existing.app_id, message: 'Application already received.', deduped: true });
    }
  }

  // ── Per-email 24h dedup: surface the existing app instead of double-billing ─
  {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from('applications')
      .select('app_id, property_id, created_at')
      .ilike('email', email)
      .eq('property_id', submittedPropertyId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent?.app_id) {
      return jsonOk({ success: true, appId: recent.app_id, message: 'A recent application already exists for this email and property.', deduped: true });
    }
  }

  // ── Build the row (server-controlled fields override anything from client) ─
  const appId = generateAppId();
  // Mint a one-click sign-in link so the success card and the confirmation
  // email both drop the applicant straight into /tenant/portal.html — no need
  // to retype their email and wait for a magic link. Falls back automatically
  // to the legacy login URL if Supabase auth.admin.generateLink fails.
  const portalUrl = await generateMagicLoginUrl(supabase, email, { appId });

  const application: Record<string, unknown> = {
    app_id: appId,
    submission_uuid: submissionUuid,
    status: 'pending',
    first_name: firstName,
    last_name: lastName,
    email,
    phone: fv(fields['Phone']) || null,
    dob: dob || null,
    ssn: (() => { const raw = fv(fields['SSN']); if (!raw) return null; const d = raw.replace(/\D/g, ''); return d.length >= 4 ? 'XXX-XX-' + d.slice(-4) : '****'; })() || null,
    property_address: enforcedAddress,
    property_id: submittedPropertyId,
    requested_move_in_date: fv(fields['Requested Move-in Date']) || null,
    desired_lease_term: fv(fields['Desired Lease Term']) || null,
    current_address: fv(fields['Current Address']) || null,
    residency_duration: fv(fields['Residency Duration']) || null,
    current_rent_amount: fv(fields['Current Rent Amount']) || null,
    reason_for_leaving: fv(fields['Reason for leaving']) || null,
    current_landlord_name: fv(fields['Current Landlord Name']) || null,
    landlord_phone: fv(fields['Landlord Phone']) || null,
    previous_address: fv(fields['Previous Address']) || null,
    previous_residency_duration: fv(fields['Previous Residency Duration']) || null,
    previous_landlord_name: fv(fields['Previous Landlord Name']) || null,
    previous_landlord_phone: fv(fields['Previous Landlord Phone']) || null,
    employment_status: fv(fields['Employment Status']) || null,
    employer: fv(fields['Employer']) || null,
    employer_address: fv(fields['Employer Address']) || null,
    job_title: fv(fields['Job Title']) || null,
    employment_start_date: fv(fields['Employment Start Date']) || null,
    employment_duration: fv(fields['Employment Duration']) || null,
    supervisor_name: fv(fields['Supervisor Name']) || null,
    supervisor_phone: fv(fields['Supervisor Phone']) || null,
    monthly_income: fv(fields['Monthly Income']) || null,
    other_income: fv(fields['Other Income']) || null,
    reference_1_name: fv(fields['Reference 1 Name']) || null,
    reference_1_phone: fv(fields['Reference 1 Phone']) || null,
    reference_1_relationship: fv(fields['Reference 1 Relationship']) || null,
    reference_2_name: fv(fields['Reference 2 Name']) || null,
    reference_2_phone: fv(fields['Reference 2 Phone']) || null,
    reference_2_relationship: fv(fields['Reference 2 Relationship']) || null,
    emergency_contact_name: fv(fields['Emergency Contact Name']) || null,
    emergency_contact_phone: fv(fields['Emergency Contact Phone']) || null,
    emergency_contact_relationship: fv(fields['Emergency Contact Relationship']) || null,
    primary_payment_method: fv(fields['Primary Payment Method']) || null,
    primary_payment_method_other: fv(fields['Primary Payment Method Other']) || null,
    alternative_payment_method: fv(fields['Alternative Payment Method']) || null,
    alternative_payment_method_other: fv(fields['Alternative Payment Method Other']) || null,
    third_choice_payment_method: fv(fields['Third Choice Payment Method']) || null,
    third_choice_payment_method_other: fv(fields['Third Choice Payment Method Other']) || null,
    has_pets: fBool(fields['Has Pets']),
    pet_details: fv(fields['Pet Details']) || null,
    total_occupants: fNum(fields['Total Occupants']),
    additional_occupants: fv(fields['Additional Occupants']) || null,
    ever_evicted: fBool(fields['Ever Evicted']),
    smoker: fBool(fields['Smoker']),
    preferred_contact_method: fv(fields['Preferred Contact Method']) || null,
    preferred_time: fv(fields['Preferred Time']) || null,
    preferred_time_specific: fv(fields['Preferred Time Specific']) || null,
    vehicle_make: fv(fields['Vehicle Make']) || null,
    vehicle_model: fv(fields['Vehicle Model']) || null,
    vehicle_year: fv(fields['Vehicle Year']) || null,
    vehicle_license_plate: fv(fields['Vehicle License Plate']) || null,
    has_co_applicant: fBool(fields['Has Co-Applicant']),
    co_applicant_first_name: fv(fields['Co-Applicant First Name']) || null,
    co_applicant_last_name: fv(fields['Co-Applicant Last Name']) || null,
    co_applicant_email: fv(fields['Co-Applicant Email']) || null,
    co_applicant_phone: fv(fields['Co-Applicant Phone']) || null,
    co_applicant_dob:   coDob || null,
    co_applicant_ssn: (() => { const raw = fv(fields['Co-Applicant SSN']); if (!raw) return null; const d = raw.replace(/\D/g, ''); return d.length >= 4 ? 'XXX-XX-' + d.slice(-4) : '****'; })() || null,
    // Server-authoritative fee/rent/deposit (overrides anything from client)
    application_fee: enforcedFee,
    monthly_rent: enforcedRent,
    security_deposit: enforcedDeposit,
    lease_status: 'none',
    move_in_status: 'pending',
    payment_status: fPaymentStatus(null),
    terms_consent: termsConsent,
    sms_consent: fv(fields['SMS Consent']) === 'yes' || fBool(fields['SMS Consent']) === true || fBool(fields['smsConsent']) === true,
    consent_timestamp: new Date().toISOString(),    // server clock — never trust client
    consent_version: fv(fields['Consent Version']) || '2.0',
  };

  // Strip undefined and empty strings, BUT keep boolean false (terms_consent etc.)
  const cleanApp = Object.fromEntries(
    Object.entries(application).filter(([, val]) => {
      if (val === null || val === undefined) return false;
      if (typeof val === 'string' && val === '') return false;
      return true;
    })
  );

  // ── Insert; unique index on submission_uuid handles concurrent retries ────
  const { error: insertErr } = await supabase.from('applications').insert(cleanApp);
  if (insertErr) {
    // 23505 = unique violation → another concurrent request beat us; fetch and return.
    if ((insertErr as { code?: string }).code === '23505') {
      const { data: dup } = await supabase
        .from('applications').select('app_id')
        .eq('submission_uuid', submissionUuid).maybeSingle();
      if (dup?.app_id) {
        return jsonOk({ success: true, appId: dup.app_id, portal_login_url: portalUrl, message: 'Application already received.', deduped: true });
      }
    }
    console.error('Insert error:', JSON.stringify(insertErr));
    return jsonErr(500, 'Failed to save application');
  }

  // ── Persist attached documents to storage ────────────────────────────────
  // Frontend sends files as _docFile_0_name / _docFile_0_type / _docFile_0_data (base64).
  // Process them non-blockingly so a storage hiccup never loses the application record.
  try {
    let docIdx = 0;
    while (fields[`_docFile_${docIdx}_data`]) {
      const origName  = fv(fields[`_docFile_${docIdx}_name`]) || `document_${docIdx}`;
      const mimeType  = fv(fields[`_docFile_${docIdx}_type`]) || 'application/octet-stream';
      const b64       = fields[`_docFile_${docIdx}_data`];

      // Server-side MIME allowlist — only accept PDF and common images
      const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
      if (!ALLOWED_MIME.has(mimeType)) {
        console.warn(`[CP] Skipping doc idx=${docIdx} — disallowed MIME type: ${mimeType}`);
        docIdx++;
        continue;
      }

      // Decode base64 → Uint8Array for storage upload
      const binStr = atob(b64);
      const bytes  = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

      // Safe path: application-docs/{appId}/applicant_upload/{ts}_{filename}
      const safeName    = origName.replace(/[^a-zA-Z0-9._\-]/g, '_');
      const storagePath = `${appId}/applicant_upload/${Date.now()}_${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from('application-docs')
        .upload(storagePath, bytes, { contentType: mimeType, upsert: false });

      if (!uploadErr) {
        await supabase.from('application_documents').insert({
          app_id:              appId,
          bucket:              'application-docs',
          storage_path:        storagePath,
          original_file_name:  origName,
          mime_type:           mimeType,
          doc_type:            'applicant_upload',
          status:              'uploaded',
          uploaded_by_email:   email,
          metadata: { submitted_with_application: true, file_index: docIdx },
        });
      } else {
        console.error(`[CP] Doc upload failed idx=${docIdx}:`, uploadErr.message);
      }

      docIdx++;
    }
  } catch (docErr) {
    console.error('[CP] Document processing error (non-fatal):', docErr);
  }

  // ── Append-only consent record ────────────────────────────────────────────
  try {
    await supabase.from('consent_log').insert({
      app_id: appId,
      submission_uuid: submissionUuid,
      email,
      consent_version: String(application.consent_version),
      terms_consent: termsConsent,
      sms_consent: !!application.sms_consent,
      ip: ip === 'unknown' ? null : ip,
      user_agent: ua || null,
    });
  } catch (e) {
    console.error('consent_log insert failed (non-fatal):', e);
  }

  // ── Notification emails ───────────────────────────────────────────────────
  const propLabel = enforcedAddress || 'your chosen property';

  const logEmail = async (
    type: string,
    recipient: string,
    status: string,
    provider: string,
    errorMsg: string | null = null,
  ) => {
    const { error } = await supabase.from('email_logs').insert({
      app_id: appId, type, recipient, status, provider, error_msg: errorMsg,
    });
    if (error) console.error('Email log insert failed:', error.message);
  };

  const emailJobs = [
    sendEmail({
      to: email,
      subject: `Application Received — ${propLabel.split(',')[0]} | Choice Properties (Ref: ${appId})`,
      html: applicationConfirmationHtml(firstName, propLabel, appId, fields, portalUrl, enforcedFee ?? null),
    }).then(result => logEmail('application_confirmation', email, result.ok ? 'sent' : 'failed', result.provider, result.ok ? null : (result.error || 'send failed')))
      .catch(async err => {
        console.error('Confirmation email error:', err);
        await logEmail('application_confirmation', email, 'failed', 'none', err?.message || 'unknown error');
      }),
    ...ADMIN_EMAILS.map(adminEmail =>
      sendEmail({
        to: adminEmail,
        subject: `New Application — ${appId} | ${firstName} ${lastName}`,
        html: adminNotificationHtml(firstName, lastName, email, propLabel, appId, fields, enforcedFee ?? null),
      }).then(result => logEmail('admin_notification', adminEmail, result.ok ? 'sent' : 'failed', result.provider, result.ok ? null : (result.error || 'send failed')))
        .catch(async err => {
          console.error('Admin notification error:', err);
          await logEmail('admin_notification', adminEmail, 'failed', 'none', err?.message || 'unknown error');
        })
    ),
    // Landlord notification — new application on their property
    (async () => {
      try {
        const landlordInfo = await getLandlordForProperty(supabase, submittedPropertyId);
        if (landlordInfo?.email) {
          await sendEmail({
            to: landlordInfo.email,
            subject: `New Application — ${propLabel.split(',')[0]} (Ref: ${appId})`,
            html: landlordNewApplicationHtml(
              landlordInfo.contact_name || '',
              firstName, lastName, email, propLabel, appId,
              getAdminUrl('/admin/applications.html'),
            ),
          }).then(result => logEmail('landlord_new_application', landlordInfo.email, result.ok ? 'sent' : 'failed', result.provider, result.ok ? null : (result.error || 'send failed')))
            .catch(() => {});
        }
      } catch (_) {}
    })(),
  ];

  await Promise.all(emailJobs);

  // Suppress unused-import warning in environments without the helper
  void sha256Hex;

  return jsonOk({ success: true, appId, portal_login_url: portalUrl, message: 'Application received.' });
});
