import { getAdminUrl, getContactEmail, getSiteUrl, getTenantLoginUrl } from './config.ts';

// ─── Utilities ────────────────────────────────────────────────────────────────

export function formatMoney(amount: number | string): string {
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function safeFee(val: unknown): string {
  const n = parseFloat(String(val ?? '').replace(/[^0-9.]/g, ''));
  return (!isNaN(n) && n > 0) ? n.toFixed(0) : '—';
}

function getESignText(state: string): string {
  const map: Record<string, string> = {
    AL: 'Alabama Uniform Electronic Transactions Act',
    AK: 'Alaska Uniform Electronic Transactions Act',
    AZ: 'Arizona Uniform Electronic Transactions Act',
    CA: 'California Uniform Electronic Transactions Act',
    CO: 'Colorado Uniform Electronic Transactions Act',
    FL: 'Florida Electronic Signature Act',
    GA: 'Georgia Electronic Records and Signatures Act',
    IL: 'Illinois Electronic Commerce Security Act',
    MI: 'Michigan Electronic Signature Act (MCL § 450.832 et seq.) and the federal Electronic Signatures in Global and National Commerce Act (E-SIGN)',
    MN: 'Minnesota Uniform Electronic Transactions Act',
    NV: 'Nevada Electronic Transactions Act',
    NJ: 'New Jersey Uniform Electronic Transactions Act',
    NY: 'New York Electronic Signatures and Records Act',
    NC: 'North Carolina Uniform Electronic Transactions Act',
    OH: 'Ohio Uniform Electronic Transactions Act',
    PA: 'Pennsylvania Electronic Transactions Act',
    TX: 'Texas Uniform Electronic Transactions Act',
    WA: 'Washington Uniform Electronic Transactions Act',
    WI: 'Wisconsin Uniform Electronic Transactions Act',
  };
  const law = map[state?.toUpperCase()] || 'applicable state Electronic Transactions Act and the federal E-SIGN Act';
  return law.includes('federal') ? law : `${law} and the federal Electronic Signatures in Global and National Commerce Act (E-SIGN)`;
}

// ─── Shared Layout Constants ───────────────────────────────────────────────────

const EMAIL_BASE_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif; -webkit-font-smoothing:antialiased; color:#1a1a1a; }
  .email-wrapper { max-width:600px; margin:24px auto; background:#ffffff; border:1px solid #e0e0e0; border-radius:4px; overflow:hidden; }
  .email-header { background:#ffffff; padding:32px 40px 24px; border-bottom:3px solid #1a5276; }
  .header-brand { font-size:20px; font-weight:700; color:#1a1a1a; letter-spacing:0.3px; margin-bottom:3px; }
  .header-sub   { font-size:12px; color:#666666; margin-bottom:14px; }
  .header-title { font-size:22px; font-weight:700; color:#1a1a1a; line-height:1.3; margin-bottom:8px; }
  .header-ref   { font-size:12px; color:#888888; font-family:monospace; }
  .status-line { padding:12px 40px; font-size:13px; font-weight:600; border-bottom:1px solid #e8e8e8; }
  .status-pending  { color:#b45309; }
  .status-paid     { color:#166534; }
  .status-approved { color:#166534; }
  .status-denied   { color:#991b1b; }
  .status-lease    { color:#1e40af; }
  .email-body { padding:36px 40px; }
  .greeting   { font-size:16px; font-weight:600; color:#1a1a1a; margin-bottom:16px; }
  .intro-text { font-size:14px; color:#444444; line-height:1.7; margin-bottom:28px; }
  .section { margin-bottom:28px; }
  .section-label { font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#888888; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid #e8e8e8; }
  .info-table { width:100%; border-collapse:collapse; }
  .info-table tr td { padding:10px 0; font-size:14px; vertical-align:top; border-bottom:1px solid #f0f0f0; }
  .info-table tr:last-child td { border-bottom:none; }
  .info-table td:first-child { width:42%; font-weight:600; color:#555555; padding-right:12px; }
  .info-table td:last-child  { color:#1a1a1a; }
  .callout { border-left:3px solid #1a5276; padding:14px 18px; margin:20px 0; background:#ffffff; }
  .callout.green  { border-color:#166534; }
  .callout.amber  { border-color:#b45309; }
  .callout.red    { border-color:#991b1b; }
  .callout h4 { font-size:13px; font-weight:700; color:#1a1a1a; margin-bottom:6px; }
  .callout p  { font-size:13px; color:#444444; line-height:1.65; }
  .steps-list { list-style:none; margin:0; padding:0; }
  .steps-list li { display:flex; align-items:flex-start; gap:14px; padding:11px 0; border-bottom:1px solid #f0f0f0; font-size:14px; color:#333333; line-height:1.6; }
  .steps-list li:last-child { border-bottom:none; }
  .step-num { flex-shrink:0; width:24px; height:24px; background:#1a5276; color:#ffffff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; }
  .financial-row { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #f0f0f0; font-size:14px; }
  .financial-row:last-child { border-bottom:none; }
  .financial-row .f-label { color:#555555; }
  .financial-row .f-value { font-weight:700; color:#1a1a1a; }
  .cta-wrap { text-align:center; margin:32px 0 24px; }
  .cta-btn  { display:inline-block; background:#1a5276; color:#ffffff !important; text-decoration:none; padding:14px 36px; border-radius:4px; font-size:14px; font-weight:700; letter-spacing:0.5px; }
  .cta-note { font-size:11px; color:#888888; text-align:center; margin-top:8px; word-break:break-all; }
  .contact-row { padding:16px 0; border-top:1px solid #e8e8e8; border-bottom:1px solid #e8e8e8; margin:24px 0; font-size:13px; color:#444444; }
  .email-closing { margin-top:28px; padding-top:20px; border-top:1px solid #e8e8e8; }
  .closing-text { font-size:13px; color:#666666; line-height:1.65; margin-bottom:14px; }
  .sign-off     { font-size:14px; font-weight:700; color:#1a1a1a; margin-bottom:2px; }
  .sign-company { font-size:13px; color:#666666; }
  .email-footer { background:#f8f8f8; border-top:1px solid #e0e0e0; padding:20px 40px; text-align:center; }
  .footer-name    { font-size:13px; font-weight:700; color:#1a1a1a; margin-bottom:4px; }
  .footer-details { font-size:12px; color:#888888; line-height:1.7; }
  .pay-pill { display:inline-block; border:1px solid #cccccc; border-radius:3px; padding:5px 12px; font-size:13px; color:#333333; margin:3px 4px 3px 0; }
  @media only screen and (max-width:600px) {
    .email-body   { padding:24px 20px; }
    .email-header { padding:24px 20px 18px; }
    .email-footer { padding:16px 20px; }
    .status-line  { padding:10px 20px; }
    .cta-btn { padding:13px 24px; }
  }
`;

const POLICY_BASE_URL = 'https://choice-properties-site.pages.dev';

const EMAIL_FOOTER = `
  <div class="email-footer">
    <div class="footer-name">Choice Properties</div>
    <div class="footer-details">
      2265 Livernois, Suite 500 &middot; Troy, MI 48083<br>
      707-706-3137 (Text Only) &middot; support@choiceproperties.com<br>
      Your trust is our standard.
    </div>
    <div class="footer-details" style="margin-top:12px;font-size:11px;line-height:1.6;">
      <a href="${POLICY_BASE_URL}/policies.html" style="color:#666;text-decoration:underline;">Policy Framework</a> &middot;
      <a href="${POLICY_BASE_URL}/terms.html" style="color:#666;text-decoration:underline;">Terms</a> &middot;
      <a href="${POLICY_BASE_URL}/privacy.html" style="color:#666;text-decoration:underline;">Privacy</a> &middot;
      <a href="${POLICY_BASE_URL}/fair-housing.html" style="color:#666;text-decoration:underline;">Fair Housing</a> &middot;
      <a href="${POLICY_BASE_URL}/policy-changelog.html" style="color:#666;text-decoration:underline;">Changelog</a>
    </div>
    <div class="footer-details" style="margin-top:10px;font-size:10px;color:#9aa3af;line-height:1.5;">
      You are receiving this transactional email because you submitted an application or signed a lease through Choice Properties. This is not a marketing message.<br>
      <strong>SMS:</strong> Reply HELP for help, STOP to opt out. Msg &amp; data rates may apply. SMS opt-out does not affect application emails.<br>
      Policy Framework v2.0 &middot; Effective April 22, 2026.
    </div>
  </div>
`;

function buildEmailHeader(title: string, appId?: string): string {
  return `
  <div class="email-header">
    <div class="header-brand">Choice Properties</div>
    <div class="header-sub">Nationwide Rental Marketplace</div>
    <div class="header-title">${title}</div>
    ${appId ? `<div class="header-ref">Reference: ${appId}</div>` : ''}
  </div>`;
}

const CONTACT_ROW = `<div class="contact-row"><strong>Questions?</strong> &nbsp; Text: 707-706-3137 &nbsp;&middot;&nbsp; support@choiceproperties.com</div>`;

// ─── Template 1: Application Confirmation (Tenant) ────────────────────────────

export interface ApplicationFields {
  'First Name'?: string;
  'Last Name'?: string;
  'Email'?: string;
  'Phone'?: string;
  'Property Address'?: string;
  'Property Name'?: string;
  'Requested Move-in Date'?: string;
  'Desired Lease Term'?: string;
  'Application Fee'?: string | number;
  'Employment Status'?: string;
  'Employer'?: string;
  'Job Title'?: string;
  'Monthly Income'?: string | number;
  'Employment Duration'?: string;
  'Preferred Contact Method'?: string;
  'Preferred Time'?: string;
  'Preferred Time Specific'?: string;
  'SMS Consent'?: 'yes' | 'no' | string;
  'Terms Consent'?: 'yes' | 'no' | string;
  'Consent Timestamp'?: string;
  'Consent Version'?: string;
  [key: string]: unknown;
}

export function applicationConfirmationHtml(
  firstName: string,
  propertyAddress: string,
  appId: string,
  fields?: ApplicationFields,
  dashboardLink?: string,
  enforcedFee?: number | null,
): string {
  const portal = dashboardLink || getTenantLoginUrl(appId, String(fields?.['Email'] || ''));
  const feeRaw = fields?.['Application Fee'];
  const feeNum = enforcedFee != null ? enforcedFee : (feeRaw != null ? Number(feeRaw) : -1);
  const hasFee = feeNum > 0;
  const freeApp = feeNum === 0;
  const feeDisplay = hasFee ? `$${feeNum.toFixed(0)}` : (freeApp ? 'Free' : 'Per property terms');
  const payMethods = [
    fields?.['Primary Payment Method'],
    fields?.['Alternative Payment Method'],
    fields?.['Third Choice Payment Method'],
  ].filter(Boolean) as string[];
  const phoneRef = fields?.['Phone'] ? ` at <strong>${fields['Phone']}</strong>` : '';
  const payPills = payMethods.length ? `<div>${payMethods.map(m => `<span class="pay-pill">${m}</span>`).join('')}</div>` : '';
  const paymentSection = hasFee
    ? `<div class="section"><div class="section-label">Application Fee &amp; Payment</div><div class="callout amber"><h4>Application Fee \u2014 ${feeDisplay}</h4><p style="margin-bottom:12px;">A member of our leasing team will contact you within 24 hours via text${phoneRef} to coordinate your application fee. Your application will not be reviewed until payment is received and confirmed.</p>${payPills}</div></div>`
    : freeApp
      ? `<div class="section"><div class="section-label">Application Fee &amp; Payment</div><div class="callout green"><h4>No Application Fee Required</h4><p>This property has no application fee. Your application will proceed directly to the screening queue \u2014 no payment step is required.</p></div></div>`
      : `<div class="section"><div class="section-label">Application Fee &amp; Payment</div><div class="callout amber"><h4>Application Fee \u2014 ${feeDisplay}</h4><p style="margin-bottom:12px;">A member of our leasing team will contact you to confirm any applicable application fee before your application proceeds to review.</p></div></div>`;
  const nextSteps = hasFee
    ? `<ul class="steps-list"><li><span class="step-num">1</span><span><strong>Payment Arrangement</strong> \u2014 Our leasing team will contact you within 24 hours to coordinate your application fee via your preferred payment method.</span></li><li><span class="step-num">2</span><span><strong>Payment Confirmation</strong> \u2014 Once your fee is received and confirmed, you will receive an email notification and your application will advance to the review stage.</span></li><li><span class="step-num">3</span><span><strong>Application Review</strong> \u2014 Our team will conduct a thorough review within 24\u201372 hours of payment confirmation. Applicants who complete steps promptly are often prioritized in the review queue.</span></li><li><span class="step-num">4</span><span><strong>Decision Notification</strong> \u2014 You will be notified of our decision via email. If approved, our leasing team will prepare your lease agreement for signature.</span></li></ul>`
    : `<ul class="steps-list"><li><span class="step-num">1</span><span><strong>Application Review</strong> \u2014 Our team will conduct a thorough review of your application. No fee is required for this property.</span></li><li><span class="step-num">2</span><span><strong>Screening</strong> \u2014 A background and credit check will be completed. This typically takes 24\u201372 hours from submission.</span></li><li><span class="step-num">3</span><span><strong>Decision Notification</strong> \u2014 You will be notified of our decision via email. If approved, our leasing team will reach out to arrange next steps.</span></li></ul>`;
  const agreementFeeLine = hasFee
    ? `The <strong>${feeDisplay} application fee is non-refundable</strong> once payment is confirmed, except as described in the <a href="${POLICY_BASE_URL}/application-credit-policy.html" style="color:#1a5276;">Application Credit Policy</a>.`
    : freeApp
      ? 'There is no application fee for this property.'
      : `Application fees, where applicable, are non-refundable once payment is confirmed, except as described in the <a href="${POLICY_BASE_URL}/application-credit-policy.html" style="color:#1a5276;">Application Credit Policy</a>.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Application Received — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Application Successfully Received', appId)}
  ${hasFee ? '<div class="status-line status-pending">&#x23F3; &nbsp; Awaiting Application Fee &middot; Review Pending</div>' : freeApp ? '<div class="status-line" style="color:#166534;background:#f0fdf4">&#x2713; &nbsp; Application Received &middot; No Fee Required &middot; Entering Review</div>' : '<div class="status-line status-pending">&#x23F3; &nbsp; Application Received &middot; Review Pending</div>'}
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">Thank you for choosing Choice Properties. We have successfully received your rental application and your file is now in our system. This confirmation serves as your official acknowledgment that your submission has been recorded.</p>

    <div class="section">
      <div class="section-label">Application Summary</div>
      <table class="info-table">
        <tr><td>Application ID</td><td><strong>${appId}</strong></td></tr>
        <tr><td>Applicant Name</td><td>${firstName} ${fields?.['Last Name'] || ''}</td></tr>
        <tr><td>Property of Interest</td><td>${propertyAddress || 'To be confirmed'}</td></tr>
        <tr><td>Requested Move-In</td><td>${fields?.['Requested Move-in Date'] || 'Not specified'}</td></tr>
        <tr><td>Lease Term</td><td>${fields?.['Desired Lease Term'] || 'Not specified'}</td></tr>
        <tr><td>Email on File</td><td>${fields?.['Email'] || ''}</td></tr>
        <tr><td>Phone on File</td><td>${fields?.['Phone'] || ''}</td></tr>
        ${(() => { const dc = fields ? Object.keys(fields).filter(k => k.startsWith('_docFile_') && k.endsWith('_name')).length : 0; return dc > 0 ? `<tr><td>Documents Submitted</td><td><strong>${dc} file${dc > 1 ? 's' : ''} attached</strong> — accessible via your tenant portal</td></tr>` : ''; })()}
      </table>
    </div>

    ${paymentSection}

    <div class="section">
      <div class="section-label">What Happens Next</div>
      ${nextSteps}
    </div>

    <div class="callout">
      <h4>Important — Save Your Application ID</h4>
      <p>Your application ID is <strong>${appId}</strong>. Please save this reference number. You will use it to track your application status and access your tenant portal at any time.</p>
    </div>

    <div class="cta-wrap">
      <a href="${portal}" class="cta-btn">Track My Application</a>
      <div class="cta-note">Or visit: ${portal}</div>
    </div>

    <div class="section">
      <div class="section-label">Your Agreement on Record</div>
      <p style="font-size:13px;color:#555;line-height:1.65;">When you submitted this application you agreed to the
        <a href="${POLICY_BASE_URL}/terms.html" style="color:#1a5276;">Terms of Service</a> (including binding arbitration and class-action waiver in Sections 18–19),
        the <a href="${POLICY_BASE_URL}/privacy.html" style="color:#1a5276;">Privacy Policy</a>, and the
        <a href="${POLICY_BASE_URL}/policies.html" style="color:#1a5276;">Complete Policy &amp; Legal Framework</a> (v2.0).
        ${agreementFeeLine}
        ${fields?.['SMS Consent'] === 'yes'
          ? `You opted in to transactional SMS at <strong>${fields?.['Phone'] || 'the number on file'}</strong>. Reply STOP to opt out at any time.`
          : `You did not opt in to SMS — we will reach you by email and phone only.`}
      </p>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">Should you have any questions prior to hearing from our team, please do not hesitate to reach out. We are committed to making this process as clear and straightforward as possible.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 2: Admin Notification ───────────────────────────────────────────

export function adminNotificationHtml(
  firstName: string,
  lastName: string,
  email: string,
  propertyAddress: string,
  appId: string,
  fields?: ApplicationFields,
  enforcedFee?: number | null,
): string {
  const adminUrl = getAdminUrl();
  const feeRaw = fields?.['Application Fee'];
  const feeNum = enforcedFee != null ? enforcedFee : (feeRaw != null ? Number(feeRaw) : -1);
  const hasFee = feeNum > 0;
  const freeApp = feeNum === 0;
  const feeDisplay = hasFee ? `$${feeNum.toFixed(2)}` : (freeApp ? 'Free \u2014 No Fee' : 'Per property terms');
  const payMethods = [
    fields?.['Primary Payment Method'],
    fields?.['Alternative Payment Method'],
    fields?.['Third Choice Payment Method'],
  ].filter(Boolean) as string[];
  const adminPaymentSection = hasFee
    ? `<div class="section"><div class="section-label" style="color:#1d4ed8;">\ud83d\udcb3 Payment Coordination \u2014 Act First</div><div class="callout amber"><h4>Collect ${feeDisplay} Application Fee via Applicant\u2019s Preferred Method</h4>${payMethods.length ? `<p style="margin-bottom:10px;"><strong>Contact ${firstName} using:</strong></p><div style="margin-bottom:8px;">${payMethods.map((m, i) => `<span class="pay-pill" style="${i===0?'background:#1e3a8a;color:#fff;font-weight:700;':''}">${i===0?'\u2605 ':''}${m}</span>`).join('')}</div><p style="font-size:12px;color:#6b7280;margin-top:8px;">Once payment is received, open the application in the admin panel and click \u201cMark paid\u201d.</p>` : '<p>No payment method preference specified \u2014 contact applicant directly to arrange.</p>'}</div></div>`
    : freeApp
      ? `<div class="section"><div class="callout green"><h4>\u2713 No Application Fee</h4><p>No payment collection required \u2014 proceed directly to review.</p></div></div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>New Application — ${appId}</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('New Application Received', appId)}
  ${hasFee ? '<div class="status-line status-pending">&#x26A1; &nbsp; Action Required \u2014 Contact Applicant Within 24 Hours to Collect Fee</div>' : freeApp ? '<div class="status-line" style="color:#166534;background:#f0fdf4">\ud83d\udccb &nbsp; New Application \u2014 No Fee \u2014 Proceed Directly to Review</div>' : '<div class="status-line status-pending">&#x26A1; &nbsp; New Application Received \u2014 Review Required</div>'}
  <div class="email-body">
    <p class="greeting">New Application Alert,</p>
    <p class="intro-text">${hasFee ? 'A new rental application has been submitted. Contact the applicant to arrange payment of the application fee using their preferred method below, then mark as paid once confirmed.' : freeApp ? 'A new rental application has been submitted for a no-fee property. No payment collection required \u2014 proceed directly to review.' : 'A new rental application has been submitted. Review the application and take the appropriate next steps.'}</p>

    ${adminPaymentSection}

    <div class="section">
      <div class="section-label">Applicant Overview</div>
      <table class="info-table">
        <tr><td>Full Name</td><td><strong>${firstName} ${lastName}</strong></td></tr>
        <tr><td>Email</td><td>${email}</td></tr>
        <tr><td>Phone</td><td><strong>${fields?.['Phone'] || 'Not provided'}</strong> (Text preferred)</td></tr>
        <tr><td>Property Requested</td><td>${propertyAddress || 'Not specified'}</td></tr>
        <tr><td>Requested Move-In</td><td>${fields?.['Requested Move-in Date'] || 'Not specified'}</td></tr>
        <tr><td>Lease Term</td><td>${fields?.['Desired Lease Term'] || 'Not specified'}</td></tr>
        <tr><td>Contact Preference</td><td>${fields?.['Preferred Contact Method'] || 'Not specified'}</td></tr>
        <tr><td>Best Time to Reach</td><td>${[fields?.['Preferred Time'], fields?.['Preferred Time Specific']].filter(Boolean).join(' — ') || 'Any'}</td></tr>
        ${(String(fields?.['Has Co-Applicant']).toLowerCase() === 'true') ? `<tr><td>Co-Applicant</td><td><strong style="color:#7c3aed;">&#x1F465; ${[fields?.['Co-Applicant First Name'], fields?.['Co-Applicant Last Name']].filter(Boolean).join(' ') || 'Yes'}</strong>${fields?.['Co-Applicant Email'] ? ` &mdash; ${fields['Co-Applicant Email']}` : ''}</td></tr>` : ''}
        ${(() => { const docCount = fields ? Object.keys(fields).filter(k => k.startsWith('_docFile_') && k.endsWith('_name')).length : 0; return docCount > 0 ? `<tr><td>Documents Attached</td><td><strong style="color:#059669;">&#x1F4CE; ${docCount} file${docCount > 1 ? 's' : ''} — view in admin portal</strong></td></tr>` : ''; })()}
      </table>
    </div>

    ${fields?.['Employment Status'] ? `
    <div class="section">
      <div class="section-label">Employment &amp; Income</div>
      <table class="info-table">
        <tr><td>Employment Status</td><td>${fields?.['Employment Status'] || 'Not specified'}</td></tr>
        <tr><td>Employer</td><td>${fields?.['Employer'] || 'N/A'}</td></tr>
        <tr><td>Job Title</td><td>${fields?.['Job Title'] || 'N/A'}</td></tr>
        <tr><td>Monthly Income</td><td>${fields?.['Monthly Income'] ? '$' + Number(fields['Monthly Income']).toLocaleString() : 'Not specified'}</td></tr>
        <tr><td>Employment Duration</td><td>${fields?.['Employment Duration'] || 'N/A'}</td></tr>
      </table>
    </div>
    ` : ''}

    ${(String(fields?.['Ever Evicted']).toLowerCase() === 'true' || String(fields?.['Has Criminal History']).toLowerCase() === 'true' || String(fields?.['Has Bankruptcy']).toLowerCase() === 'true' || (String(fields?.['Has Pets']).toLowerCase() === 'true') || String(fields?.['Smoker']).toLowerCase() === 'true') ? `
    <div class="section">
      <div class="section-label">Application Flags — Review Required</div>
      <div class="callout red">
        <h4>&#x26A0; Disclosed Items</h4>
        <p>
          ${String(fields?.['Ever Evicted']).toLowerCase() === 'true' ? '<strong>Prior Eviction:</strong> Applicant disclosed a prior eviction record.<br>' : ''}
          ${String(fields?.['Has Criminal History']).toLowerCase() === 'true' ? '<strong>Criminal History:</strong> Applicant disclosed criminal history.<br>' : ''}
          ${String(fields?.['Has Bankruptcy']).toLowerCase() === 'true' ? '<strong>Bankruptcy:</strong> Applicant disclosed prior bankruptcy.<br>' : ''}
          ${String(fields?.['Has Pets']).toLowerCase() === 'true' ? `<strong>Pets:</strong> ${fields?.['Pet Details'] || 'Has pets — verify property pet policy.'}<br>` : ''}
          ${String(fields?.['Smoker']).toLowerCase() === 'true' ? '<strong>Smoker:</strong> Applicant disclosed smoking — verify property policy.<br>' : ''}
        </p>
      </div>
    </div>
    ` : ''}

    <div class="section">
      <div class="section-label">Quick Actions</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;">
        <a href="${adminUrl}" style="display:inline-block;background:#0a1628;color:white;text-decoration:none;padding:11px 22px;border-radius:3px;font-size:13px;font-weight:600;">Admin Dashboard</a>
        <a href="mailto:${email}?subject=Your%20Application%20${appId}%20-%20Choice%20Properties" style="display:inline-block;background:#1d4ed8;color:white;text-decoration:none;padding:11px 22px;border-radius:3px;font-size:13px;font-weight:600;">Email Applicant</a>
        ${fields?.['Phone'] ? `<a href="sms:${fields['Phone'].toString().replace(/\D/g,'')}?body=Hi%20${firstName}%2C%20this%20is%20Choice%20Properties%20regarding%20your%20application%20${appId}" style="display:inline-block;background:#059669;color:white;text-decoration:none;padding:11px 22px;border-radius:3px;font-size:13px;font-weight:600;">Text Applicant</a>` : ''}
      </div>
    </div>

    <div class="email-closing">
      <div class="sign-off">Choice Properties System</div>
      <div class="sign-company">Automated Admin Notification &mdash; ${appId}</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 3: Status Update (Approved / Denied / Waitlisted) ───────────────

export function statusUpdateHtml(
  appId: string,
  firstName: string,
  status: 'approved' | 'denied' | 'waitlisted',
  reason: string | undefined,
  dashboardLink: string,
  propertyAddress: string,
  propertyName?: string,
  propertyState?: string,
): string {
  const portal = dashboardLink || getTenantLoginUrl(appId);
  const isApproved = status === 'approved';
  const isWaitlisted = status === 'waitlisted';
  const propertyLabel = propertyName || propertyAddress;
  const eSignText = getESignText(propertyState || 'MI');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${isApproved ? 'Application Approved' : isWaitlisted ? 'You\'ve Been Waitlisted' : 'Application Update'} — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader(isApproved ? 'Application Approved' : isWaitlisted ? 'Application Status Update' : 'Application Update', appId)}
  <div class="status-line ${isApproved ? 'status-approved' : isWaitlisted ? 'status-lease' : 'status-denied'}">
    ${isApproved ? '&#x2713; &nbsp; Congratulations — Your Application Has Been Approved' : isWaitlisted ? '&#x23F3; &nbsp; You Have Been Added to the Waitlist' : '&mdash; &nbsp; Your Application Has Been Reviewed'}
  </div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    ${propertyLabel ? `<p style="font-size:13px;color:#64748b;margin:-4px 0 16px;">Property: <strong>${propertyLabel}</strong></p>` : ''}

    ${isApproved ? `
    <p class="intro-text">We are delighted to inform you that your rental application with Choice Properties has been <strong>approved</strong>. This decision reflects our confidence in your application, and we look forward to welcoming you as a resident.</p>
    <div class="callout green">
      <h4>&#x2713; Application Approved</h4>
      <p>Your application has met all of our criteria. Our leasing team will be in contact with you shortly to prepare and deliver your lease agreement for electronic signature. Please ensure your phone and email remain accessible.</p>
    </div>
    <div class="section">
      <div class="section-label">Your Next Steps</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Lease Agreement</strong> — Our team will prepare a formal lease agreement and send it to you shortly. Please review it carefully in its entirety before signing.</span></li>
        <li><span class="step-num">2</span><span><strong>Electronic Signature</strong> — You will sign your lease electronically. Your signature is legally binding under the ${eSignText}.</span></li>
        <li><span class="step-num">3</span><span><strong>Move-In Costs</strong> — Prior to receiving your keys, the move-in total (first month's rent plus security deposit) must be paid in full. This will be clearly outlined in your lease.</span></li>
        <li><span class="step-num">4</span><span><strong>Key Handoff</strong> — Once all documents and payments are complete, our team will coordinate your move-in date.</span></li>
      </ul>
    </div>
    <div class="callout amber">
      <h4>Important — Please Respond Promptly</h4>
      <p>Approval qualifies you to move forward, but the unit is not yet held in your name. Units are secured on a <strong>first-completion basis</strong> among approved applicants — the next steps (holding fee, then lease signing within 48 hours) are what formally remove this property from the market. Delays may result in the unit being awarded to another approved applicant.</p>
    </div>

    <div class="callout">
      <h4>Why We Move Quickly at This Stage</h4>
      <p style="font-size:13px;color:#555;line-height:1.65;">Approved listings often have multiple qualified applicants. Moving promptly through the holding-fee and signing steps is how we make sure the right unit is secured for the right resident — without leaving anyone in limbo. Our team is available throughout to answer questions before you commit.</p>
    </div>
    ` : isWaitlisted ? `
    <p class="intro-text">Thank you for your application for <strong>${propertyLabel}</strong>. We have reviewed your application and have added you to our active waitlist for this property.</p>
    <div class="callout" style="border-color:#1e40af;">
      <h4>&#x23F3; You Are on the Active Waitlist</h4>
      <p>${reason || 'Your application is complete and has been placed in our priority waitlist queue. We will contact you as soon as a unit becomes available or a comparable property opens up.'}</p>
    </div>
    <div class="section">
      <div class="section-label">What This Means</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Active Monitoring</strong> — Your application remains active in our system. We review the waitlist regularly and contact applicants as availability changes.</span></li>
        <li><span class="step-num">2</span><span><strong>Other Properties</strong> — You are encouraged to browse our current listings. If you see another property that interests you, contact us to discuss your application.</span></li>
        <li><span class="step-num">3</span><span><strong>Stay Reachable</strong> — Please keep your phone and email accessible. When a unit becomes available, we will reach out promptly. A timely response is important.</span></li>
      </ul>
    </div>
    <div class="cta-wrap">
      <a href="${getSiteUrl()}/listings.html" class="cta-btn">View Available Properties</a>
    </div>
    ` : `
    <p class="intro-text">Thank you for the time and effort you invested in your rental application. After careful and thorough consideration, we regret to inform you that we are unable to offer you a tenancy at this time.</p>
    <div class="callout red">
      <h4>Application Status — Not Approved</h4>
      <p>${reason ? `After review, the primary consideration relates to: <strong>${reason}</strong>. ` : ''}Our decision is based on our standard application review criteria. We understand this is disappointing and we genuinely appreciate the trust you placed in us by applying.</p>
    </div>
    <div class="section">
      <div class="section-label">Looking Ahead</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Reapplication Option</strong> — Your application and screening results remain on file for 60 days. If you wish to apply for another available Choice Properties unit within 30 days, <strong>no new application fee will be required</strong>. Please contact our team to discuss your options.</span></li>
        <li><span class="step-num">2</span><span><strong>Other Properties</strong> — Choice Properties manages a portfolio of properties. Our team would be happy to discuss alternative options that may be a strong fit for your current profile.</span></li>
        <li><span class="step-num">3</span><span><strong>Questions</strong> — If you would like to discuss this decision or explore your options, please reach out to our leasing team directly.</span></li>
      </ul>
    </div>
    <div class="callout" style="border-color:#888888;">
      <p style="font-size:12px;color:#666666;line-height:1.7;"><strong>Fair Housing Notice:</strong> Choice Properties is committed to complying with all applicable Fair Housing laws. We do not discriminate on the basis of race, color, national origin, religion, sex, familial status, disability, or any other class protected by federal, state, or local law. If you believe you have been treated unfairly, you may contact the U.S. Department of Housing and Urban Development (HUD) at hud.gov or call 1-800-669-9777.</p>
    </div>
    `}

    <div class="cta-wrap">
      <a href="${portal}" class="cta-btn">View My Application</a>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">${isApproved ? 'Congratulations once more. We look forward to having you as part of the Choice Properties community.' : isWaitlisted ? 'Thank you for your patience. We will be in touch as soon as an opportunity arises.' : 'Thank you again for your interest in Choice Properties. We wish you all the best.'}</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// Backward-compatible wrappers
export function approvalEmailHtml(firstName: string, propertyAddress: string, message?: string): string {
  const portal = getTenantLoginUrl();
  return statusUpdateHtml('', firstName, 'approved', message, portal, propertyAddress);
}

export function denialEmailHtml(firstName: string, propertyAddress: string, message?: string): string {
  const portal = getTenantLoginUrl();
  return statusUpdateHtml('', firstName, 'denied', message, portal, propertyAddress);
}

export function waitlistedEmailHtml(firstName: string, propertyAddress: string, message?: string): string {
  const portal = getTenantLoginUrl();
  return statusUpdateHtml('', firstName, 'waitlisted', message, portal, propertyAddress);
}

// ─── Template 4: Payment Confirmed ────────────────────────────────────────────

export function paymentConfirmedHtml(
  firstName: string,
  propertyAddress: string,
  amount?: number | string,
  method?: string,
  ref?: string,
  message?: string,
  phone?: string,
  appId?: string,
  propertyName?: string,
): string {
  const portal = getTenantLoginUrl(appId);
  const feeDisplay = amount != null ? formatMoney(amount) : '—';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Payment Confirmed — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Application Fee Confirmed', appId)}
  <div class="status-line status-paid">&#x2713; &nbsp; Payment Received — Application Now Under Review</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">We are pleased to confirm that your application fee has been received and successfully recorded. Your application is now active and has been placed in our review queue. Thank you for completing this step promptly.</p>

    <div class="section">
      <div class="section-label">Payment Confirmation</div>
      <div class="callout green">
        <h4>&#x2713; Payment Successfully Received</h4>
        ${appId ? `<div class="financial-row"><span class="f-label">Receipt ID</span><span class="f-value">${appId}-PMT</span></div>` : ''}
        ${appId ? `<div class="financial-row"><span class="f-label">Application ID</span><span class="f-value">${appId}</span></div>` : ''}
        <div class="financial-row"><span class="f-label">Applicant</span><span class="f-value">${firstName}</span></div>
        ${propertyAddress || propertyName ? `<div class="financial-row"><span class="f-label">Property</span><span class="f-value">${propertyName || propertyAddress}</span></div>` : ''}
        <div class="financial-row"><span class="f-label">Amount Paid</span><span class="f-value">${feeDisplay}</span></div>
        <div class="financial-row"><span class="f-label">Payment Date</span><span class="f-value">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span></div>
        ${method ? `<div class="financial-row"><span class="f-label">Payment Method</span><span class="f-value">${method}</span></div>` : ''}
        ${ref ? `<div class="financial-row"><span class="f-label">Reference / Note</span><span class="f-value">${ref}</span></div>` : ''}
        <div class="financial-row"><span class="f-label">Status</span><span class="f-value" style="color:#059669;">Under Review</span></div>
      </div>
    </div>

    ${message ? `<div class="callout"><p>${message}</p></div>` : ''}

    <div class="section">
      <div class="section-label">What Happens Next</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Active Review</strong> — Your complete application is now being reviewed by our leasing team. Applications are typically processed within 24–72 hours of payment confirmation.</span></li>
        <li><span class="step-num">2</span><span><strong>Background &amp; Income Verification</strong> — We will conduct standard verification procedures as part of our review process.</span></li>
        <li><span class="step-num">3</span><span><strong>Decision Notification</strong> — You will receive an email once a decision has been made.${phone ? ` Our team may also reach out via text at <strong>${phone}</strong> if additional information is needed.` : ''}</span></li>
      </ul>
    </div>

    <div class="callout">
      <h4>A Note on Our Review Process</h4>
      <p>We conduct every review with care and fairness. Applicants who remain responsive and provide complete information are often processed more quickly. There is nothing further required from you at this time.</p>
    </div>

    <div class="cta-wrap">
      <a href="${portal}" class="cta-btn">Track My Application</a>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">We appreciate your patience as we complete our review. Should you have any questions in the interim, please do not hesitate to contact our leasing team.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 5: Holding Fee Request ──────────────────────────────────────────

export function holdingFeeRequestHtml(
  firstName: string,
  propertyAddress: string,
  feeAmount?: number | string,
  dueDate?: string,
  message?: string,
  appId?: string,
  applicantPaymentMethods?: string[],
): string {
  const portal = getTenantLoginUrl(appId);
  const deadlineText = dueDate ? new Date(dueDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '48 hours from this email';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Action Required — Holding Fee</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Holding Fee Request', appId)}
  <div class="status-line status-lease">&#x1F3E0; &nbsp; Action Required — Reserve Your Unit</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">Congratulations — your application for <strong>${propertyAddress}</strong> has been conditionally approved. To formally reserve this unit and remove it from active availability, a holding fee is required.</p>

    <div class="callout amber">
      <h4>&#x23F0; Time-Sensitive — Reserve Within ${deadlineText}</h4>
      <p>Without a holding fee on file, this property remains available to other approved applicants on a <strong>first-completion basis</strong>. This fee fully secures your unit while your lease is being finalized. <strong>This fee is credited in full toward your move-in costs — it is not an additional charge.</strong></p>
    </div>

    <div class="callout">
      <h4>Why We Require a Holding Fee</h4>
      <p style="font-size:13px;color:#555;line-height:1.65;">Approval qualifies you to move forward, but it does not by itself remove the unit from the market. A holding fee is the formal step that takes the property off availability so no other approved applicant can claim it ahead of you. It protects the time we both invest in preparing your lease, and it is the cleanest way to confirm mutual commitment before signing.</p>
    </div>

    ${feeAmount != null ? `
    <div class="section">
      <div class="section-label">Holding Fee Details</div>
      <div class="callout">
        <div class="financial-row"><span class="f-label">Holding Fee Amount</span><span class="f-value">${formatMoney(feeAmount)}</span></div>
        <div class="financial-row"><span class="f-label">Due By</span><span class="f-value">${deadlineText}</span></div>
        <div class="financial-row"><span class="f-label">Applied Toward</span><span class="f-value">Move-In Balance (credited in full)</span></div>
      </div>
    </div>
    ` : ''}

    <div class="section">
      <div class="section-label">How to Pay</div>
      <div class="callout">
        <h4>A Leasing Team Member Will Contact You Directly</h4>
        <p>Our leasing team will reach out to you shortly to coordinate collection of your holding fee.</p>
        ${applicantPaymentMethods && applicantPaymentMethods.length > 0 ? `
        <p style="margin-top:12px;font-size:13px;color:#555555;">Based on your application, you indicated a preference for:</p>
        <div style="margin-top:8px;">${applicantPaymentMethods.map(m => `<span class="pay-pill">${m}</span>`).join('')}</div>
        <p style="margin-top:10px;font-size:13px;color:#555555;">Our team will confirm the specific payment details at the time of contact.</p>
        ` : '<p style="margin-top:10px;font-size:13px;color:#555555;">Our team will work with your preferred payment method at the time of contact.</p>'}
      </div>
    </div>

    ${message ? `<div class="callout"><p>${message}</p></div>` : ''}

    <div class="section">
      <div class="section-label">After Payment is Confirmed</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span>Our team confirms receipt and records your payment — you will receive an email confirmation.</span></li>
        <li><span class="step-num">2</span><span>Your unit is formally reserved and removed from active availability.</span></li>
        <li><span class="step-num">3</span><span>Our team prepares your lease agreement for electronic signature.</span></li>
      </ul>
    </div>

    <div class="callout amber">
      <h4>Refund &amp; Forfeiture Summary</h4>
      <p style="margin-bottom:8px;"><strong>Fully credited:</strong> the holding deposit is applied 100% toward your move-in costs once the lease is executed.</p>
      <p style="margin-bottom:8px;"><strong>May be refunded:</strong> if the property becomes unavailable through no fault of yours, or materially differs from how it was advertised — see Section 9 of the <a href="${POLICY_BASE_URL}/policies.html#s9" style="color:#1a5276;">Policy Framework</a>.</p>
      <p style="margin-bottom:0;"><strong>May be forfeited:</strong> if you withdraw, fail to sign the lease in time, or change your mind — see the <a href="${POLICY_BASE_URL}/holding-deposit-policy.html" style="color:#1a5276;">Holding Deposit Policy</a>.</p>
    </div>

    <div class="cta-wrap">
      <a href="${portal}" class="cta-btn">View My Application</a>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">Please act promptly to secure your unit. Our team is here to answer any questions you may have about this step.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 6: Holding Fee Received ─────────────────────────────────────────

export function holdingFeeReceivedHtml(
  firstName: string,
  propertyAddress: string,
  portalUrl: string,
  message?: string,
  feeAmount?: number | string,
  remainingBalance?: number | string,
  appId?: string,
): string {
  const portal = appId ? getTenantLoginUrl(appId) : portalUrl;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Holding Fee Received — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Holding Fee Received — Unit Reserved', appId)}
  <div class="status-line status-approved">&#x2713; &nbsp; Holding Fee Confirmed — Your Unit is Reserved</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">We have received your holding fee for <strong>${propertyAddress}</strong>. Your unit is now formally reserved and has been removed from active availability. Thank you for acting promptly.</p>

    <div class="callout green">
      <h4>&#x2713; Holding Fee Confirmed — Unit Secured</h4>
      ${feeAmount != null ? `<div class="financial-row"><span class="f-label">Amount Received</span><span class="f-value">${formatMoney(feeAmount)}</span></div>` : ''}
      <div class="financial-row"><span class="f-label">Applied Toward</span><span class="f-value">Move-In Balance (credited in full)</span></div>
      ${remainingBalance != null ? `<div class="financial-row"><span class="f-label">Remaining Move-In Balance</span><span class="f-value">${formatMoney(remainingBalance)}</span></div>` : ''}
      <div class="financial-row"><span class="f-label">Unit Status</span><span class="f-value" style="color:#059669;">Reserved</span></div>
    </div>

    ${message ? `<div class="callout"><p>${message}</p></div>` : ''}

    <div class="callout amber">
      <h4>Refund &amp; Forfeiture Summary</h4>
      <p style="margin-bottom:8px;"><strong>Fully credited:</strong> the holding deposit you just paid will be applied 100% toward your move-in costs once the lease is executed.</p>
      <p style="margin-bottom:8px;"><strong>May be refunded:</strong> if the property becomes unavailable through no fault of yours, or materially differs from how it was advertised — see Section 9 of the <a href="${POLICY_BASE_URL}/policies.html#s9" style="color:#1a5276;">Policy Framework</a>.</p>
      <p style="margin-bottom:0;"><strong>May be forfeited:</strong> if you withdraw, fail to sign the lease in time, or change your mind before signing — see the <a href="${POLICY_BASE_URL}/holding-deposit-policy.html" style="color:#1a5276;">Holding Deposit Policy</a>.</p>
    </div>

    <div class="section">
      <div class="section-label">What Happens Next</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Lease Agreement</strong> — Your lease agreement will be prepared and sent to you shortly for electronic signature.</span></li>
        <li><span class="step-num">2</span><span><strong>Remaining Move-In Payment</strong> — Once your lease is signed, the remaining move-in balance will be due before key handoff.</span></li>
        <li><span class="step-num">3</span><span><strong>Move-In Coordination</strong> — Our team will contact you to confirm your move-in date and key pickup details.</span></li>
      </ul>
    </div>

    <div class="cta-wrap">
      <a href="${portal}" class="cta-btn">View My Application</a>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">We look forward to welcoming you as a Choice Properties resident.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 7: Lease Ready to Sign ──────────────────────────────────────────

export function signingEmailHtml(
  firstName: string,
  propertyAddress: string,
  signingUrl: string,
  appId: string,
  leaseData?: { term?: string; startDate?: string; endDate?: string; rent?: string | number; deposit?: string | number; moveInCosts?: string | number; propertyState?: string },
): string {
  const eSignText = getESignText(leaseData?.propertyState || 'MI');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your Lease Agreement is Ready — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Your Lease Agreement is Ready', appId)}
  <div class="status-line status-lease">&#x1F4CB; &nbsp; Action Required — Please Review and Sign Within 48 Hours</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">We are pleased to inform you that your lease agreement for <strong>${propertyAddress}</strong> has been prepared and is now ready for your review and electronic signature. Please read the agreement carefully in its entirety before signing.</p>

    ${leaseData ? `
    <div class="section">
      <div class="section-label">Lease Summary</div>
      <table class="info-table">
        <tr><td>Property</td><td><strong>${propertyAddress}</strong></td></tr>
        ${leaseData.term ? `<tr><td>Lease Term</td><td>${leaseData.term}</td></tr>` : ''}
        ${leaseData.startDate ? `<tr><td>Lease Start Date</td><td>${leaseData.startDate}</td></tr>` : ''}
        ${leaseData.endDate ? `<tr><td>Lease End Date</td><td>${leaseData.endDate}</td></tr>` : ''}
        ${leaseData.rent ? `<tr><td>Monthly Rent</td><td>${formatMoney(leaseData.rent)}</td></tr>` : ''}
        ${leaseData.deposit ? `<tr><td>Security Deposit</td><td>${formatMoney(leaseData.deposit)}</td></tr>` : ''}
        ${leaseData.moveInCosts ? `<tr><td>Total Due at Move-In</td><td><strong>${formatMoney(leaseData.moveInCosts)}</strong></td></tr>` : ''}
      </table>
    </div>
    ` : ''}

    <div class="callout amber">
      <h4>&#x23F0; 48-Hour Signing Window</h4>
      <p>To secure your unit, your lease must be signed within <strong>48 hours</strong> of receiving this email. Units are confirmed on a first-completed basis. If you require additional time, please contact our team immediately.</p>
    </div>

    <div class="callout amber">
      <h4>Holding Deposit — Refund &amp; Forfeiture Reminder</h4>
      <p style="margin-bottom:8px;"><strong>Fully credited:</strong> once you sign, your holding deposit is applied 100% toward your move-in costs.</p>
      <p style="margin-bottom:8px;"><strong>May be refunded:</strong> if the property becomes unavailable through no fault of yours, or materially differs from how it was advertised — see Section 9 of the <a href="${POLICY_BASE_URL}/policies.html#s9" style="color:#1a5276;">Policy Framework</a>.</p>
      <p style="margin-bottom:0;"><strong>May be forfeited:</strong> if you do not sign within the 48-hour window above, withdraw, or change your mind before signing — see the <a href="${POLICY_BASE_URL}/holding-deposit-policy.html" style="color:#1a5276;">Holding Deposit Policy</a>.</p>
    </div>

    <div class="cta-wrap">
      <a href="${signingUrl}" class="cta-btn">Review &amp; Sign My Lease</a>
      <div class="cta-note">Or copy this link: ${signingUrl}</div>
    </div>

    <div class="section">
      <div class="section-label">What to Expect When You Sign</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Review the Full Agreement</strong> — Read every section carefully. The lease outlines your rights, responsibilities, and all financial obligations.</span></li>
        <li><span class="step-num">2</span><span><strong>Confirm Checkboxes</strong> — You will be asked to confirm your agreement to specific terms before signing.</span></li>
        <li><span class="step-num">3</span><span><strong>Sign Electronically</strong> — Enter your full legal name as your electronic signature. This is legally binding under the ${eSignText}.</span></li>
        <li><span class="step-num">4</span><span><strong>Receive Confirmation</strong> — You will receive an immediate email confirmation once your signature is recorded.</span></li>
      </ul>
    </div>

    <p style="color:#718096;font-size:13px;margin:0 0 8px;">Application ID: <strong>${appId}</strong></p>
    <p style="color:#718096;font-size:13px;">This signing link is unique to you. Do not share it.</p>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">If you have any questions about the lease terms prior to signing, please contact our leasing team. We are available to clarify any aspect of the agreement.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 8: Lease Signed (Tenant Confirmation) ───────────────────────────

export function signedConfirmHtml(
  firstName: string,
  propertyAddress: string,
  appId: string,
  leaseData?: { startDate?: string; endDate?: string; rent?: string | number; moveInCost?: string | number; signature?: string },
): string {
  const portal = getTenantLoginUrl(appId);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lease Signed — Welcome to Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Welcome to Choice Properties', appId)}
  <div class="status-line status-lease">&#x270D; &nbsp; Signature Received — Awaiting Management Countersignature</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">Your electronic signature for the lease at <strong>${propertyAddress}</strong> has been successfully recorded. Your lease is now pending management countersignature. Once management signs, both parties will receive a fully executed copy and your tenancy will be officially confirmed.</p>

    <div class="callout" style="border-color:#1e40af;">
      <h4>&#x270D; Signature Recorded — Next: Management Countersignature</h4>
      <div class="financial-row"><span class="f-label">Property</span><span class="f-value">${propertyAddress}</span></div>
      ${leaseData?.startDate ? `<div class="financial-row"><span class="f-label">Move-In Date</span><span class="f-value">${leaseData.startDate}</span></div>` : ''}
      ${leaseData?.endDate ? `<div class="financial-row"><span class="f-label">Lease End Date</span><span class="f-value">${leaseData.endDate}</span></div>` : ''}
      ${leaseData?.rent ? `<div class="financial-row"><span class="f-label">Monthly Rent</span><span class="f-value">${formatMoney(leaseData.rent)}</span></div>` : ''}
      ${leaseData?.moveInCost ? `<div class="financial-row"><span class="f-label">Move-In Total Due</span><span class="f-value">${formatMoney(leaseData.moveInCost)}</span></div>` : ''}
      <div class="financial-row"><span class="f-label">Application ID</span><span class="f-value">${appId}</span></div>
    </div>

    <div class="section">
      <div class="section-label">What Happens Next</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Management Countersignature</strong> — Our team will countersign your lease. This typically happens within 1–2 business days. You will receive a confirmation email once complete.</span></li>
        <li><span class="step-num">2</span><span><strong>Fully Executed Copy</strong> — Once both parties have signed, you will receive a final copy of the fully executed lease agreement for your records.</span></li>
        <li><span class="step-num">3</span><span><strong>Move-In Coordination</strong> — Our team will then contact you to finalize your move-in date, payment, and key handoff.</span></li>
      </ul>
    </div>

    <div class="callout amber">
      <h4>Please Note</h4>
      <p>Your lease is not legally binding until management has countersigned. Please do not make any moving arrangements until you receive the "Lease Fully Executed" confirmation email.</p>
    </div>

    <div class="cta-wrap">
      <a href="${portal}" class="cta-btn">View My Tenant Portal</a>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">We appreciate your patience during this final step. Our team will process your countersignature promptly. If you have any questions in the meantime, please don't hesitate to reach out.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 9: Lease Fully Executed (Management Countersigned) ───────────────

export function leaseFullyExecutedHtml(
  firstName: string,
  propertyAddress: string,
  portalUrl: string,
  appId?: string,
  leaseData?: { startDate?: string; endDate?: string; rent?: string | number; deposit?: string | number; moveInCost?: string | number },
): string {
  const portal = appId ? getTenantLoginUrl(appId) : portalUrl;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lease Fully Executed — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Your Lease Has Been Fully Executed', appId)}
  <div class="status-line status-approved">&#x2713; &nbsp; Both Parties Have Signed — Your Tenancy is Official</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">Congratulations! Your lease for <strong>${propertyAddress}</strong> has been fully executed — both you and management have signed. Your tenancy is now officially confirmed. You may download your fully executed lease from your tenant portal.</p>

    <div class="callout green">
      <h4>&#x2713; Lease Fully Executed — Tenancy Confirmed</h4>
      <div class="financial-row"><span class="f-label">Property</span><span class="f-value">${propertyAddress}</span></div>
      ${leaseData?.startDate ? `<div class="financial-row"><span class="f-label">Lease Start Date</span><span class="f-value">${leaseData.startDate}</span></div>` : ''}
      ${leaseData?.endDate ? `<div class="financial-row"><span class="f-label">Lease End Date</span><span class="f-value">${leaseData.endDate}</span></div>` : ''}
      ${leaseData?.rent ? `<div class="financial-row"><span class="f-label">Monthly Rent</span><span class="f-value">${formatMoney(leaseData.rent)}</span></div>` : ''}
      ${leaseData?.deposit ? `<div class="financial-row"><span class="f-label">Security Deposit</span><span class="f-value">${formatMoney(leaseData.deposit)}</span></div>` : ''}
      ${leaseData?.moveInCost ? `<div class="financial-row"><span class="f-label">Move-In Total Due</span><span class="f-value"><strong>${formatMoney(leaseData.moveInCost)}</strong></span></div>` : ''}
      ${appId ? `<div class="financial-row"><span class="f-label">Application ID</span><span class="f-value">${appId}</span></div>` : ''}
      <p style="margin-top:12px;font-size:13px;color:#444444;">Your lease is legally binding. Please retain this email and your lease document for your records.</p>
    </div>

    <div class="section">
      <div class="section-label">What Happens Next</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Move-In Payment</strong> — Our team will contact you to coordinate your move-in payment${leaseData?.moveInCost ? ` of <strong>${formatMoney(leaseData.moveInCost)}</strong>` : ''}. This must be received in full before key handoff.</span></li>
        <li><span class="step-num">2</span><span><strong>Move-In Coordination</strong> — Our team will finalize your move-in date, time, and key handoff logistics with you directly.</span></li>
        <li><span class="step-num">3</span><span><strong>Download Your Lease</strong> — Your fully executed lease is available in your tenant portal. Save a copy for your records.</span></li>
      </ul>
    </div>

    <div class="cta-wrap">
      <a href="${portal}" class="cta-btn">Go to Tenant Portal</a>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">We look forward to welcoming you to your new home. Our team is here to ensure a smooth and enjoyable move-in experience.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 10: Move-In Confirmed ───────────────────────────────────────────

export function moveinEmailHtml(
  firstName: string,
  propertyAddress: string,
  moveInDate?: string,
  message?: string,
  appId?: string,
): string {
  const portal = getTenantLoginUrl(appId);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Move-In Confirmed — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Move-In Confirmed', appId)}
  <div class="status-line status-approved">&#x1F3E0; &nbsp; Your Move-In Date is Confirmed</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">We are excited to confirm your upcoming move-in to <strong>${propertyAddress}</strong>. Everything is in order and we look forward to handing you your keys.</p>

    ${moveInDate ? `
    <div class="callout green">
      <h4>&#x2713; Move-In Confirmed</h4>
      <div class="financial-row"><span class="f-label">Move-In Date</span><span class="f-value">${moveInDate}</span></div>
      <div class="financial-row"><span class="f-label">Property</span><span class="f-value">${propertyAddress}</span></div>
    </div>
    ` : ''}

    ${message ? `<div class="callout"><p>${message}</p></div>` : ''}

    <div class="callout">
      <h4>Holding Deposit — Now Credited</h4>
      <p style="margin-bottom:8px;"><strong>Fully credited:</strong> as of move-in, the holding deposit you paid earlier has been applied 100% toward your move-in costs — it was not an additional charge.</p>
      <p style="margin-bottom:0;">The refund and forfeiture terms that applied prior to move-in are governed by Section 9 of the <a href="${POLICY_BASE_URL}/policies.html#s9" style="color:#1a5276;">Policy Framework</a> and the <a href="${POLICY_BASE_URL}/holding-deposit-policy.html" style="color:#1a5276;">Holding Deposit Policy</a>. From move-in forward, your security deposit and rent obligations are governed by your signed lease.</p>
    </div>

    <div class="cta-wrap">
      <a href="${portal}" class="cta-btn">View Tenant Portal</a>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">We are thrilled to welcome you to your new home. If you have any questions before your move-in, please don't hesitate to reach out.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 11: Move-In Preparation Guide ───────────────────────────────────

export function moveInPrepHtml(
  firstName: string,
  propertyAddress: string,
  message?: string,
  appId?: string,
  leaseData?: { rent?: string | number; deposit?: string | number; moveInCost?: string | number; startDate?: string },
): string {
  const portal = getTenantLoginUrl(appId);
  const contactEmail = getContactEmail();
  const moveInTotal = leaseData?.moveInCost || (leaseData?.rent && leaseData?.deposit ? Number(leaseData.rent) + Number(leaseData.deposit) : null);
  const startDate = leaseData?.startDate ? new Date(leaseData.startDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'As agreed';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Move-In Preparation Guide — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Your Move-In Preparation Guide', appId)}
  <div class="status-line status-approved">&#x1F3E0; &nbsp; Your Lease is Signed — Here's How to Prepare</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">Congratulations on signing your lease! This guide covers everything you need to do before your move-in date${leaseData?.startDate ? ` of <strong>${startDate}</strong>` : ''}.</p>

    ${moveInTotal ? `
    <div class="callout amber">
      <h4>Move-In Payment Due Before Key Handoff</h4>
      <p>
        ${leaseData?.rent ? `<strong>First Month's Rent:</strong> ${formatMoney(leaseData.rent)}<br>` : ''}
        ${leaseData?.deposit ? `<strong>Security Deposit:</strong> ${formatMoney(leaseData.deposit)}<br>` : ''}
        <strong>Total Due:</strong> ${formatMoney(moveInTotal)}<br><br>
        Our team will contact you to arrange payment. <strong>Do not send money before speaking with us directly.</strong>
      </p>
    </div>
    ` : ''}

    ${message ? `<div class="callout"><p>${message}</p></div>` : ''}

    <div class="section">
      <div class="section-label">What to Bring on Move-In Day</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Government-Issued Photo ID</strong> — Required for all adults 18+ who will reside in the unit.</span></li>
        <li><span class="step-num">2</span><span><strong>Move-In Payment</strong> — Full move-in amount in the agreed payment form. Our team will confirm the method in advance.</span></li>
        <li><span class="step-num">3</span><span><strong>Renter's Insurance Proof</strong> — A current binder or declaration page. Your policy must be in effect before key handoff.</span></li>
      </ul>
    </div>

    <div class="section">
      <div class="section-label">Before You Move In</div>
      <ul class="steps-list">
        <li><span class="step-num">A</span><span><strong>Set Up Utilities</strong> — Electric, gas, water, and internet accounts should be transferred or opened in your name on or before your lease start date.</span></li>
        <li><span class="step-num">B</span><span><strong>Obtain Renter's Insurance</strong> — Your lease requires you to maintain renter's insurance for the full lease term. Most policies cost $10–$20/month.</span></li>
        <li><span class="step-num">C</span><span><strong>Update Your Address</strong> — File a change of address with USPS at usps.com/move and notify your bank, employer, and other services.</span></li>
        <li><span class="step-num">D</span><span><strong>Review Parking &amp; Rules</strong> — Parking assignments and community rules are outlined in your lease. Please review before your move-in day.</span></li>
      </ul>
    </div>

    <div class="callout">
      <h4>Maintenance &amp; Emergency Contact</h4>
      <p>For maintenance requests or questions, contact us by text at <strong>707-706-3137</strong> or email <strong>${contactEmail}</strong>. For property emergencies (water, electrical, structural), text us immediately.</p>
    </div>

    <div class="cta-wrap">
      <a href="${portal}" class="cta-btn">View My Tenant Portal</a>
    </div>

    <div class="email-closing">
      <p class="closing-text">We're thrilled to welcome you to your new home. Our team is here to help make your move-in smooth and stress-free.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 12: Lease Signing Reminder ──────────────────────────────────────

export function leaseSigningReminderHtml(
  firstName: string,
  propertyAddress: string,
  portalUrl: string,
  message?: string,
  appId?: string,
  signingUrl?: string,
): string {
  const portal = appId ? getTenantLoginUrl(appId) : portalUrl;
  const actionUrl = signingUrl || portal;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reminder — Sign Your Lease</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Lease Signing Reminder', appId)}
  <div class="status-line" style="color:#c2410c;">&#x23F3; &nbsp; Action Required — Your Lease Awaits Your Signature</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">This is a friendly reminder that your lease agreement for <strong>${propertyAddress}</strong> is still awaiting your electronic signature. Unit availability is time-sensitive — to protect your reservation, please sign at your earliest convenience.</p>

    <div class="callout" style="border-color:#f97316;">
      <h4 style="color:#c2410c;">Please Sign Within 48 Hours</h4>
      <p>If your lease remains unsigned, the unit may be offered to other applicants on our waiting list. If you have questions or concerns about any clause, please reach out to our team before the deadline.</p>
    </div>

    ${message ? `<div class="callout"><p>${message}</p></div>` : ''}

    <div class="cta-wrap">
      <a href="${actionUrl}" class="cta-btn">Sign My Lease Now &#x2192;</a>
      ${signingUrl ? `<div class="cta-note">Or copy this link: ${signingUrl}</div>` : ''}
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">We're excited to have you as a resident and look forward to getting your home ready. Please don't hesitate to reach out if you have any questions before signing.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 13: Lease Expiry Alert (Admin Internal) ─────────────────────────

export function leaseExpiryAlertHtml(
  firstName: string,
  propertyAddress: string,
  leaseEndDate: string,
  appId: string,
  tenantEmail: string,
  tenantPhone?: string,
): string {
  const adminUrl = getAdminUrl();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lease Unsigned — Admin Alert</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Lease Unsigned — 48h Alert', appId)}
  <div class="status-line status-denied">&#x26A0; &nbsp; Tenant Has Not Signed — 48 Hours Elapsed</div>
  <div class="email-body">
    <p class="intro-text">The lease agreement for Application <strong>${appId}</strong> has not been signed within 48 hours of delivery. Immediate follow-up is recommended to protect unit availability.</p>

    <div class="callout red">
      <h4>Applicant Contact Information</h4>
      <p>
        <strong>Name:</strong> ${firstName}<br>
        <strong>Email:</strong> ${tenantEmail}<br>
        ${tenantPhone ? `<strong>Phone:</strong> ${tenantPhone}<br>` : ''}
        <strong>Property:</strong> ${propertyAddress}<br>
        <strong>Lease End Date:</strong> ${formatDate(leaseEndDate)}
      </p>
    </div>

    <div class="section">
      <div class="section-label">Suggested Actions</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span>Contact the applicant by text${tenantPhone ? ` at <strong>${tenantPhone}</strong>` : ''} to confirm they received the lease and address any questions.</span></li>
        <li><span class="step-num">2</span><span>If no response within 24 hours, evaluate whether the unit should be re-listed.</span></li>
        <li><span class="step-num">3</span><span>If cancelling, update the application status in the admin panel and notify the applicant.</span></li>
      </ul>
    </div>

    <div class="cta-wrap">
      <a href="${adminUrl}" class="cta-btn">View in Admin Panel &#x2192;</a>
    </div>

    <div class="contact-row">This alert was generated automatically by the Choice Properties rental system. Application ID: <strong>${appId}</strong></div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Template 14: Admin Review Summary (Holding Fee Received) ─────────────────

export function adminReviewSummaryHtml(
  firstName: string,
  lastName: string,
  email: string,
  phone: string,
  propertyAddress: string,
  appId: string,
  feeReceived?: number | string,
  appData?: Record<string, unknown>,
): string {
  const adminUrl = getAdminUrl('/admin/leases.html');
  const now = new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const row = (label: string, value: unknown) => value
    ? `<tr><td style="padding:8px 10px;font-size:13px;color:#555555;width:42%;border-bottom:1px solid #f0f0f0;">${label}</td><td style="padding:8px 10px;font-size:13px;color:#1a1a1a;font-weight:500;border-bottom:1px solid #f0f0f0;">${value}</td></tr>`
    : '';

  const section = (title: string) =>
    `<tr><td colspan="2" style="padding:10px 10px 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#888888;background:#f8f8f8;">${title}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Review Summary — ${appId}</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Fee Confirmed — Action Required', appId)}
  <div class="status-line status-approved">&#x2713; &nbsp; Fee Confirmed — Generate Lease Document</div>
  <div class="email-body">
    <p class="intro-text">The holding fee for Application <strong>${appId}</strong> has been confirmed. Please log in to the admin panel and generate the lease document for this applicant.</p>

    <div class="callout green">
      <h4>&#x2713; Holding Fee Received — Lease Generation Required</h4>
      <div class="financial-row"><span class="f-label">Applicant</span><span class="f-value">${firstName} ${lastName}</span></div>
      <div class="financial-row"><span class="f-label">Property</span><span class="f-value">${propertyAddress}</span></div>
      ${feeReceived != null ? `<div class="financial-row"><span class="f-label">Holding Fee Received</span><span class="f-value">${formatMoney(feeReceived)}</span></div>` : ''}
      <div class="financial-row"><span class="f-label">Received At</span><span class="f-value">${now}</span></div>
    </div>

    ${appData ? `
    <div class="section">
      <div class="section-label">Applicant Summary</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden;">
        <tbody>
          ${section('Contact')}
          ${row('Full Name', `${firstName} ${lastName}`)}
          ${row('Email', email)}
          ${row('Phone', phone)}
          ${section('Property')}
          ${row('Property Address', propertyAddress)}
          ${row('Monthly Rent', appData['monthly_rent'] ? formatMoney(String(appData['monthly_rent'])) : null)}
          ${row('Requested Move-In', appData['requested_move_in_date'])}
          ${section('Employment')}
          ${row('Employment Status', appData['employment_status'])}
          ${row('Employer', appData['employer'])}
          ${row('Monthly Income', appData['monthly_income'] ? '$' + Number(appData['monthly_income']).toLocaleString() : null)}
        </tbody>
      </table>
    </div>
    ` : `
    <div class="section">
      <div class="section-label">Applicant Details</div>
      <table class="info-table">
        <tr><td>Name</td><td>${firstName} ${lastName}</td></tr>
        <tr><td>Email</td><td>${email}</td></tr>
        <tr><td>Phone</td><td>${phone || '—'}</td></tr>
        <tr><td>Property</td><td>${propertyAddress}</td></tr>
        <tr><td>App ID</td><td><strong>${appId}</strong></td></tr>
      </table>
    </div>
    `}

    <p style="color:#1a1a1a;font-size:14px;font-weight:600;margin:16px 0;">Recommended next action: Generate the lease document for this applicant in the Lease Pipeline.</p>

    <div class="cta-wrap">
      <a href="${adminUrl}" class="cta-btn">Go to Lease Pipeline &#x2192;</a>
    </div>

    <div class="contact-row">This summary was generated automatically when the holding fee was confirmed. Application ID: <strong>${appId}</strong></div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Phase 3 — Co-Applicant Invitation ──────────────────────────────────────

export function coApplicantInviteHtml(
  coFirstName: string,
  primaryName: string,
  propertyAddress: string,
  signingUrl: string,
  appId: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your Co-Applicant Lease is Ready to Sign — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Your Co-Applicant Lease is Ready', appId)}
  <div class="status-line status-lease">&#x270D; &nbsp; Action Required — Co-Applicant Signature Needed</div>
  <div class="email-body">
    <p class="greeting">Dear ${coFirstName},</p>
    <p class="intro-text"><strong>${primaryName}</strong> has signed the lease for <strong>${propertyAddress}</strong> as the primary applicant and listed you as a co-applicant. The lease cannot be finalized by management until you also sign.</p>
    <p class="intro-text">Please review the full lease agreement carefully. By signing, you will be jointly and severally liable for all obligations under the lease alongside the primary applicant.</p>

    <div class="callout amber">
      <h4>&#x23F0; Please Sign Within 48 Hours</h4>
      <p>To keep the application on schedule, please complete your signature within <strong>48 hours</strong>. If you require additional time or have questions, please contact our team.</p>
    </div>

    <div class="cta-wrap">
      <a href="${signingUrl}" class="cta-btn">Review &amp; Sign as Co-Applicant</a>
      <div class="cta-note">Or copy this link: ${signingUrl}</div>
    </div>

    <div class="section">
      <div class="section-label">What to Expect</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Review the Full Lease</strong> — Including the signature already recorded by the primary applicant.</span></li>
        <li><span class="step-num">2</span><span><strong>Confirm Your Identity</strong> — You will enter the email address you were contacted at on this message.</span></li>
        <li><span class="step-num">3</span><span><strong>Sign Electronically</strong> — Type your full legal name. This is legally binding under the federal E-SIGN Act and applicable state law.</span></li>
        <li><span class="step-num">4</span><span><strong>Management Countersignature</strong> — Once you sign, management will countersign and both of you will receive a fully executed copy.</span></li>
      </ul>
    </div>

    <p style="color:#718096;font-size:13px;">This signing link is unique to you. Do not share it.</p>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">If you did not expect this email, or believe you were listed as a co-applicant in error, please contact us immediately and do <strong>not</strong> sign.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Phase 3 — Co-Applicant Signed Confirmation ─────────────────────────────

export function coApplicantSignedHtml(coFirstName: string, propertyAddress: string, appId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Co-Applicant Signature Received — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Your Signature Has Been Recorded', appId)}
  <div class="status-line status-paid">&#x2705; &nbsp; Co-Applicant Signature Received</div>
  <div class="email-body">
    <p class="greeting">Dear ${coFirstName},</p>
    <p class="intro-text">Thank you. Your electronic signature on the lease for <strong>${propertyAddress}</strong> has been successfully recorded as a co-applicant. The lease will now be sent to management for final countersignature.</p>

    <div class="callout green">
      <h4>What Happens Next</h4>
      <p style="margin-bottom:8px;">Management will countersign the lease, typically within 1-2 business days. Once countersigned, both you and the primary applicant will receive a copy of the fully executed lease.</p>
      <p style="margin-bottom:0;">No further action is required from you at this time.</p>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Phase 4 — Lease Amendment Request ──────────────────────────────────────

export function amendmentRequestHtml(
  firstName: string,
  propertyAddress: string,
  amendmentTitle: string,
  signingUrl: string,
  appId: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lease Amendment Ready to Sign — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Lease Amendment Ready', appId)}
  <div class="status-line status-lease">&#x1F4DD; &nbsp; Action Required — Amendment Signature Needed</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">Management has prepared an amendment to your existing lease for <strong>${propertyAddress}</strong>. This is a separate document that will be added to your file once signed; it does not replace your original lease.</p>

    <div class="callout" style="border-color:#1e40af;">
      <h4>${amendmentTitle}</h4>
      <p>Please review the full text of the amendment carefully before signing. If anything is unclear, contact our team before proceeding.</p>
    </div>

    <div class="cta-wrap">
      <a href="${signingUrl}" class="cta-btn">Review &amp; Sign Amendment</a>
      <div class="cta-note">Or copy this link: ${signingUrl}</div>
    </div>

    <div class="callout amber">
      <h4>You Are Not Required to Sign</h4>
      <p>If you do not agree with the proposed amendment, you may decline by simply not signing, or by replying to this email with your concerns. Your existing lease remains in effect either way.</p>
    </div>

    <p style="color:#718096;font-size:13px;">This signing link is unique to you. Do not share it.</p>

    ${CONTACT_ROW}

    <div class="email-closing">
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Phase 4 — Amendment Signed Confirmation ────────────────────────────────

export function amendmentSignedHtml(
  firstName: string,
  propertyAddress: string,
  amendmentTitle: string,
  appId: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Amendment Signed — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Amendment Signed', appId)}
  <div class="status-line status-paid">&#x2705; &nbsp; Amendment Recorded — Added to Your Lease File</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">Your signature on the following amendment has been recorded and the document is now part of your lease file for <strong>${propertyAddress}</strong>:</p>

    <div class="callout green">
      <h4>${amendmentTitle}</h4>
      <p>A copy of the signed amendment is available in your tenant portal. Please retain this email for your records.</p>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Phase 4 — Lease Renewal Nudge ──────────────────────────────────────────

export function renewalNudgeHtml(
  firstName: string,
  propertyAddress: string,
  leaseEndDate: string,
  daysRemaining: number,
  appId: string,
): string {
  const friendlyEnd = formatDate(leaseEndDate);
  const urgencyTone = daysRemaining <= 30 ? 'amber' : '';
  const urgencyHeader = daysRemaining <= 30
    ? `&#x23F0; Less Than ${daysRemaining} Days Remaining`
    : `Lease Renewal Window Open`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lease Renewal Coming Up — Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Lease Renewal Coming Up', appId)}
  <div class="status-line status-lease">&#x1F4C5; &nbsp; ${daysRemaining} Days Until Lease Ends</div>
  <div class="email-body">
    <p class="greeting">Dear ${firstName},</p>
    <p class="intro-text">A friendly reminder that your lease for <strong>${propertyAddress}</strong> is scheduled to end on <strong>${friendlyEnd}</strong> &mdash; that is approximately <strong>${daysRemaining} days from today</strong>.</p>

    <div class="callout ${urgencyTone}">
      <h4>${urgencyHeader}</h4>
      <p style="margin-bottom:8px;">Please let us know your plans so we can either prepare a renewal lease or coordinate move-out logistics with you.</p>
      <p style="margin-bottom:0;">Reply to this email or text us at <strong>707-706-3137</strong> to begin the conversation.</p>
    </div>

    <div class="section">
      <div class="section-label">Your Options</div>
      <ul class="steps-list">
        <li><span class="step-num">1</span><span><strong>Renew Your Lease</strong> &mdash; We will prepare an updated lease for your review and signature, typically reflecting current market rent for the property.</span></li>
        <li><span class="step-num">2</span><span><strong>Move Out</strong> &mdash; Standard notice requirements apply per your current lease. We will coordinate the move-out inspection and security deposit return.</span></li>
        <li><span class="step-num">3</span><span><strong>Month-to-Month</strong> &mdash; Where permitted by local law and the property owner, we may be able to convert your tenancy to month-to-month.</span></li>
      </ul>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">If you have already been in touch with our team about your renewal, please disregard this automated reminder.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Phase 11 — Rent Increase Notice (tenant-facing) ────────────────────────

export function rentIncreaseNoticeHtml(
  tenantName: string,
  propertyAddress: string,
  currentRent: number,
  newRent: number,
  effectiveDate: string,
  noticeDaysRequired: number,
  isLargeIncrease: boolean,
  downloadUrl: string,
  portalUrl: string,
  appId: string,
): string {
  const fmt = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const friendlyDate = new Date(effectiveDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const pct = currentRent > 0 ? ((newRent - currentRent) / currentRent * 100) : 0;
  const largeNotice = isLargeIncrease
    ? `<div class="callout amber"><h4>Extended Notice Period Applied</h4><p style="margin:0">Because this increase exceeds your state's threshold, the extended ${noticeDaysRequired}-day notice period applies. The effective date above already accounts for this.</p></div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Notice of Rent Adjustment - Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Notice of Rent Adjustment', appId)}
  <div class="email-body">
    <p class="greeting">Dear ${tenantName},</p>
    <p class="intro-text">This notice is being provided to inform you of an upcoming adjustment to the monthly rent for <strong>${propertyAddress}</strong>. A formal written notice has been generated and is attached to this email as a PDF for your records.</p>

    <div class="section">
      <div class="section-label">Adjustment Summary</div>
      <table class="info-table">
        <tr><td>Current monthly rent</td><td><strong>${fmt(currentRent)}</strong></td></tr>
        <tr><td>New monthly rent</td><td><strong>${fmt(newRent)}</strong></td></tr>
        <tr><td>Change</td><td><strong>${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</strong></td></tr>
        <tr><td>Effective date</td><td><strong>${friendlyDate}</strong></td></tr>
        <tr><td>Notice period</td><td>${noticeDaysRequired} days</td></tr>
      </table>
    </div>

    ${largeNotice}

    <div class="cta-wrap">
      <a href="${downloadUrl}" class="cta-btn">Download formal notice (PDF)</a>
      <div class="cta-note">The download link above is valid for 7 days.</div>
    </div>

    <div class="section">
      <div class="section-label">Questions or Concerns</div>
      <p>If you have questions about this adjustment, the underlying rent calculation, or your tenant rights under your state's rent-stabilization rules, please reach out to our team using the contact information below. You can also view this notice at any time from your tenant portal: <a href="${portalUrl}" style="color:#0f172a">${portalUrl}</a>.</p>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">Thank you for your continued tenancy.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Phase 11 — Termination Notice (tenant-facing) ──────────────────────────

export function terminationNoticeHtml(
  tenantName: string,
  propertyAddress: string,
  noticeType: string,
  effectiveDate: string,
  noticeDaysRequired: number,
  noticeStatute: string | null,
  reasonText: string | null,
  downloadUrl: string,
  portalUrl: string,
  appId: string,
): string {
  const friendlyDate = new Date(effectiveDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const typeLabels: Record<string, string> = {
    mutual: 'Mutual Termination',
    tenant_no_renewal: 'Tenant Non-Renewal',
    landlord_no_renewal: 'Landlord Non-Renewal',
    for_cause: 'For-Cause Termination',
  };
  const typeLabel = typeLabels[noticeType] || 'Lease Termination';
  const reasonBlock = reasonText
    ? `<div class="section"><div class="section-label">Stated Reason</div><p>${reasonText}</p></div>`
    : '';
  const statuteBlock = noticeStatute
    ? `<p style="font-size:13px;color:#64748b;margin-top:12px">Statutory authority: ${noticeStatute}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Notice of Lease Termination - Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader('Notice of Lease Termination', appId)}
  <div class="email-body">
    <p class="greeting">Dear ${tenantName},</p>
    <p class="intro-text">A formal notice of termination has been issued for your tenancy at <strong>${propertyAddress}</strong>. The notice has been generated as a PDF and is available via the download link below; please retain a copy for your records.</p>

    <div class="section">
      <div class="section-label">Termination Summary</div>
      <table class="info-table">
        <tr><td>Notice type</td><td><strong>${typeLabel}</strong></td></tr>
        <tr><td>Effective date</td><td><strong>${friendlyDate}</strong></td></tr>
        <tr><td>Statutory notice period</td><td>${noticeDaysRequired} days</td></tr>
      </table>
      ${statuteBlock}
    </div>

    ${reasonBlock}

    <div class="cta-wrap">
      <a href="${downloadUrl}" class="cta-btn">Download formal notice (PDF)</a>
      <div class="cta-note">The download link above is valid for 7 days.</div>
    </div>

    <div class="section">
      <div class="section-label">What Happens Next</div>
      <p>Please review the attached PDF carefully. It contains the legal effective date, your obligations during the notice period, and information about move-out coordination, the move-out inspection, and the security-deposit return process.</p>
      <p>You can revisit this notice at any time from your tenant portal: <a href="${portalUrl}" style="color:#0f172a">${portalUrl}</a>.</p>
    </div>

    ${CONTACT_ROW}

    <div class="email-closing">
      <p class="closing-text">If you have questions about the legal basis for this notice or your rights under your state's tenant-protection statute, please contact our office at the number above.</p>
      <div class="sign-off">Choice Properties Leasing Team</div>
      <div class="sign-company">support@choiceproperties.com</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Phase 09 — Deposit Dispute Filed (admin-facing) ────────────────────────

export function depositDisputeAdminHtml(
  tenantName: string,
  tenantEmail: string,
  propertyAddress: string,
  appId: string,
  accountingId: string,
  disputeText: string,
  isFirstDispute: boolean,
  stateCode: string | null,
  stateReturnDeadline: string | null,
): string {
  const safeDispute = disputeText
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  const titleText = isFirstDispute ? 'New Deposit Dispute Filed' : 'Deposit Dispute Updated';
  const deadlineRow = stateReturnDeadline
    ? `<tr><td>State return deadline</td><td>${stateReturnDeadline}</td></tr>`
    : '';
  const stateRow = stateCode ? `<tr><td>State</td><td>${stateCode}</td></tr>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${titleText} - Choice Properties</title>
  <style>${EMAIL_BASE_CSS}</style>
</head>
<body>
<div class="email-wrapper">
  ${buildEmailHeader(titleText, appId)}
  <div class="status-line" style="background:#fef2f2;color:#991b1b;border-color:#fecaca">Action Required - Tenant Has Disputed the Deposit Accounting</div>
  <div class="email-body">
    <p class="greeting">Team,</p>
    <p class="intro-text">${isFirstDispute ? 'A tenant has filed' : 'A tenant has updated'} a formal dispute against the security-deposit accounting on file. The disputed text is included below verbatim and has been persisted to <code>lease_deposit_accountings.tenant_dispute_text</code>.</p>

    <div class="section">
      <div class="section-label">Dispute Details</div>
      <table class="info-table">
        <tr><td>Tenant</td><td><strong>${tenantName}</strong></td></tr>
        <tr><td>Tenant email</td><td>${tenantEmail}</td></tr>
        <tr><td>Property</td><td>${propertyAddress}</td></tr>
        <tr><td>Application ID</td><td><strong>${appId}</strong></td></tr>
        <tr><td>Accounting ID</td><td><code>${accountingId}</code></td></tr>
        ${stateRow}
        ${deadlineRow}
      </table>
    </div>

    <div class="section">
      <div class="section-label">Tenant's Statement</div>
      <div class="callout amber" style="white-space:pre-wrap">${safeDispute}</div>
    </div>

    <div class="callout">
      <h4>Recommended Next Steps</h4>
      <p style="margin-bottom:8px">1. Review the original itemized deductions in the admin dashboard.</p>
      <p style="margin-bottom:8px">2. Respond to the tenant in writing within your state's statutory window${stateReturnDeadline ? ` (deadline on file: <strong>${stateReturnDeadline}</strong>)` : ''}.</p>
      <p style="margin-bottom:0">3. If the dispute is resolved, document the outcome in the accounting record before issuing any partial refund.</p>
    </div>

    <div class="email-closing">
      <div class="sign-off">Choice Properties System</div>
      <div class="sign-company">Automated dispute notification</div>
    </div>
  </div>
  ${EMAIL_FOOTER}
</div>
</body>
</html>`;
}

// ─── Landlord notification templates ─────────────────────────────────────────
// Compact, action-oriented emails sent directly to the property's landlord.

function buildLandlordHeader(title: string, appId?: string): string {
  return `
  <div style="background:#fff;padding:24px 32px 16px;border-bottom:3px solid #1a5276">
    <div style="font-size:18px;font-weight:700;color:#1a1a1a;margin-bottom:2px">Choice Properties</div>
    <div style="font-size:11px;color:#888;margin-bottom:12px">Landlord Notification</div>
    <div style="font-size:18px;font-weight:700;color:#1a1a1a;line-height:1.3">${title}</div>
    ${appId ? `<div style="font-size:11px;color:#888;font-family:monospace;margin-top:4px">Ref: ${appId}</div>` : ''}
  </div>`;
}

const LANDLORD_FOOTER = `
  <div style="background:#f8f8f8;border-top:1px solid #e0e0e0;padding:16px 32px;text-align:center;font-size:12px;color:#888;line-height:1.7">
    Choice Properties &middot; 2265 Livernois, Suite 500, Troy MI 48083<br>
    This notification was sent because you are the registered landlord for this property.
  </div>`;

function landlordWrap(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { margin:0;padding:0;box-sizing:border-box; }
    body { background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a; }
    .wrap { max-width:560px;margin:20px auto;background:#fff;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden; }
    .body { padding:28px 32px; }
    .row { display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f0f0;font-size:13px; }
    .row:last-child { border-bottom:none; }
    .lbl { color:#666;font-weight:600;width:40%;padding-right:8px; }
    .val { color:#111;flex:1; }
    .cta { display:inline-block;background:#1a5276;color:#fff !important;text-decoration:none;padding:12px 28px;border-radius:4px;font-size:13px;font-weight:700;margin-top:20px; }
  </style>
</head>
<body>
<div class="wrap">${content}${LANDLORD_FOOTER}</div>
</body>
</html>`;
}

export function landlordNewApplicationHtml(
  landlordName: string,
  applicantFirstName: string,
  applicantLastName: string,
  applicantEmail: string,
  propertyAddress: string,
  appId: string,
  adminUrl: string,
): string {
  const greeting = landlordName ? `Hi ${landlordName},` : 'Hello,';
  return landlordWrap(`
  ${buildLandlordHeader('New Application Received', appId)}
  <div class="body">
    <p style="font-size:15px;font-weight:600;margin-bottom:16px">${greeting}</p>
    <p style="font-size:13px;color:#444;line-height:1.7;margin-bottom:20px">
      A new rental application has been submitted for your property. Our leasing team will review it and keep you informed of each step.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:16px;margin-bottom:20px">
      <div class="row"><span class="lbl">Applicant</span><span class="val"><strong>${applicantFirstName} ${applicantLastName}</strong></span></div>
      <div class="row"><span class="lbl">Property</span><span class="val">${propertyAddress}</span></div>
      <div class="row"><span class="lbl">Reference</span><span class="val" style="font-family:monospace">${appId}</span></div>
      <div class="row"><span class="lbl">Status</span><span class="val">Under review</span></div>
    </div>
    <a href="${adminUrl}" class="cta">View in Admin Portal</a>
    <p style="font-size:12px;color:#888;margin-top:16px;line-height:1.6">You will receive another notification once the application is approved or denied. Questions? Contact us at support@choiceproperties.com</p>
  </div>`);
}

export function landlordAppStatusHtml(
  landlordName: string,
  applicantName: string,
  propertyAddress: string,
  status: 'approved' | 'denied' | 'waitlisted',
  appId: string,
  adminUrl: string,
): string {
  const greeting = landlordName ? `Hi ${landlordName},` : 'Hello,';
  const statusLabel = status === 'approved' ? '✅ Approved' : status === 'denied' ? '❌ Denied' : '⏳ Waitlisted';
  const statusColor = status === 'approved' ? '#166534' : status === 'denied' ? '#991b1b' : '#b45309';
  const detail = status === 'approved'
    ? 'The application has been approved. A lease will be generated and sent to the tenant for signature shortly.'
    : status === 'denied'
    ? 'The application has been denied. We will notify the applicant by email.'
    : 'The applicant has been placed on the waitlist pending a unit becoming available.';
  return landlordWrap(`
  ${buildLandlordHeader('Application Status Update', appId)}
  <div class="body">
    <p style="font-size:15px;font-weight:600;margin-bottom:16px">${greeting}</p>
    <p style="font-size:13px;color:#444;line-height:1.7;margin-bottom:20px">${detail}</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:16px;margin-bottom:20px">
      <div class="row"><span class="lbl">Applicant</span><span class="val"><strong>${applicantName}</strong></span></div>
      <div class="row"><span class="lbl">Property</span><span class="val">${propertyAddress}</span></div>
      <div class="row"><span class="lbl">Reference</span><span class="val" style="font-family:monospace">${appId}</span></div>
      <div class="row"><span class="lbl">Decision</span><span class="val"><strong style="color:${statusColor}">${statusLabel}</strong></span></div>
    </div>
    <a href="${adminUrl}" class="cta">View in Admin Portal</a>
  </div>`);
}

export function landlordTenantSignedHtml(
  landlordName: string,
  tenantName: string,
  propertyAddress: string,
  appId: string,
  adminUrl: string,
): string {
  const greeting = landlordName ? `Hi ${landlordName},` : 'Hello,';
  return landlordWrap(`
  ${buildLandlordHeader('Tenant Has Signed Their Lease', appId)}
  <div class="body">
    <p style="font-size:15px;font-weight:600;margin-bottom:16px">${greeting}</p>
    <p style="font-size:13px;color:#444;line-height:1.7;margin-bottom:20px">
      Your tenant has signed their lease agreement. Our team will countersign shortly, after which the fully-executed lease will be sent to all parties.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:16px;margin-bottom:20px">
      <div class="row"><span class="lbl">Tenant</span><span class="val"><strong>${tenantName}</strong></span></div>
      <div class="row"><span class="lbl">Property</span><span class="val">${propertyAddress}</span></div>
      <div class="row"><span class="lbl">Reference</span><span class="val" style="font-family:monospace">${appId}</span></div>
      <div class="row"><span class="lbl">Status</span><span class="val"><strong style="color:#1e40af">Pending countersignature</strong></span></div>
    </div>
    <a href="${adminUrl}" class="cta">View in Admin Portal</a>
  </div>`);
}

export function landlordLeaseExecutedHtml(
  landlordName: string,
  tenantName: string,
  propertyAddress: string,
  leaseStart: string | undefined,
  appId: string,
  adminUrl: string,
): string {
  const greeting = landlordName ? `Hi ${landlordName},` : 'Hello,';
  const startRow = leaseStart
    ? `<div class="row"><span class="lbl">Lease start</span><span class="val">${formatDate(leaseStart)}</span></div>`
    : '';
  return landlordWrap(`
  ${buildLandlordHeader('Lease Fully Executed', appId)}
  <div class="body">
    <p style="font-size:15px;font-weight:600;margin-bottom:16px">${greeting}</p>
    <p style="font-size:13px;color:#444;line-height:1.7;margin-bottom:20px">
      The lease for your property has been fully executed by all parties. A copy of the signed lease has been sent to the tenant. Your tenancy is now active.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:16px;margin-bottom:20px">
      <div class="row"><span class="lbl">Tenant</span><span class="val"><strong>${tenantName}</strong></span></div>
      <div class="row"><span class="lbl">Property</span><span class="val">${propertyAddress}</span></div>
      <div class="row"><span class="lbl">Reference</span><span class="val" style="font-family:monospace">${appId}</span></div>
      ${startRow}
      <div class="row"><span class="lbl">Status</span><span class="val"><strong style="color:#166534">✅ Active lease</strong></span></div>
    </div>
    <a href="${adminUrl}" class="cta">View in Admin Portal</a>
  </div>`);
}

