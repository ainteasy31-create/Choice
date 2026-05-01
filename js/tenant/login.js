'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────
let _pendingPortalAppId = '';
let _resendTimer = null;

// HTML-escape any value that gets pasted into innerHTML. Anything from
// URL params (?email=, ?redirect=, etc.) MUST go through this — without it
// a crafted link like ?email=<img src=x onerror=…> would execute on the
// login page and could steal the session that the tenant is about to create.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Validates a "?redirect=" or "?next=" param so we don't get used as an
// open-redirect (e.g. /tenant/login.html?redirect=//evil.com phishing).
// Only same-origin tenant paths are allowed; everything else falls back
// to the portal home so the tenant always lands somewhere safe.
function sanitizeNext(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // Must start with a single slash and not be a protocol-relative URL
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '';
  if (raw.includes('\\')) return '';
  // Only allow paths inside /tenant/. Reject /admin/, /landlord/, etc.
  if (!/^\/tenant\//.test(raw)) return '';
  return raw;
}

// Reads `?redirect=` first, then `?next=`, returns a sanitized path or ''.
function readNextParam() {
  const params = new URLSearchParams(window.location.search);
  return sanitizeNext(params.get('redirect') || params.get('next') || '');
}

async function waitForSB(maxMs) {
  const end = Date.now() + (maxMs || 8000);
  while (Date.now() < end) {
    if (window.supabase && typeof CONFIG !== 'undefined' && CONFIG.SUPABASE_URL) return true;
    await new Promise(r => setTimeout(r, 80));
  }
  return false;
}

// I-411: Singleton — multiple createClient() calls in the same page each spin
// up their own auth listener and refresh-token timer, causing one client to
// race the other on POST /auth/v1/token and silently invalidating the session
// (refresh token gets marked "already used"). Always reuse one instance.
let _sb = null;
function getSB() {
  if (_sb) return _sb;
  _sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // PKCE returns a refresh token so portal sessions don't drop after 1h.
      // Must match flowType in tenant/portal.html.
      flowType: 'pkce'
    }
  });
  // Keep the SDK's internal refresh-failure paths quiet by attaching at least
  // one listener (matches the pattern in js/cp-api.js).
  _sb.auth.onAuthStateChange(() => {});
  return _sb;
}

function showError(msg) {
  const el = document.getElementById('field-error');
  const input = document.getElementById('email');
  el.textContent = msg;
  el.classList.add('visible');
  input.focus();
}
function clearError() {
  const el = document.getElementById('field-error');
  el.classList.remove('visible');
}

function parseSBError(err) {
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('rate limit') || msg.includes('too many') || msg.includes('email rate limit exceeded')) {
    return 'Too many requests. Please wait a minute before trying again.';
  }
  if (msg.includes('invalid email') || msg.includes('unable to validate')) {
    return 'That email address doesn\'t look valid. Please double-check it.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return err?.message || 'Something went wrong. Please try again.';
}

function startResendCountdown(seconds) {
  const btn = document.getElementById('resend-btn');
  const cd = document.getElementById('resend-countdown');
  let remaining = seconds || 60;
  btn.disabled = true;
  cd.textContent = remaining;
  clearInterval(_resendTimer);
  _resendTimer = setInterval(() => {
    remaining--;
    cd.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(_resendTimer);
      btn.disabled = false;
      btn.textContent = 'Resend sign-in link';
      document.getElementById('resend-note').textContent = '';
    }
  }, 1000);
}

function showSuccessScreen(email) {
  document.getElementById('form-view').style.display = 'none';
  const sv = document.getElementById('success-view');
  sv.classList.add('visible');
  document.getElementById('success-email').textContent = email;
  startResendCountdown(60);
}

function resetToForm(prefillEmail) {
  clearInterval(_resendTimer);
  document.getElementById('success-view').classList.remove('visible');
  document.getElementById('form-view').style.display = '';
  const sendBtn = document.getElementById('send-btn');
  document.getElementById('btn-label').textContent = 'Send Sign-In Link';
  sendBtn.classList.remove('loading');
  sendBtn.disabled = false;
  clearError();
  if (prefillEmail) document.getElementById('email').value = prefillEmail;
  document.getElementById('signed-in-banner').classList.remove('visible');
  document.getElementById('login-form').style.display = 'block';
}

// ── Send magic link ───────────────────────────────────────────────────────────
async function sendMagicLink(emailOverride) {
  clearError();
  const emailEl = document.getElementById('email');
  const sendBtn = document.getElementById('send-btn');
  const email = (emailOverride || emailEl.value).trim().toLowerCase();
  const params = new URLSearchParams(window.location.search);
  const appId = params.get('app_id') || _pendingPortalAppId || sessionStorage.getItem('pendingPortalAppId') || '';

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    showError('Please enter a valid email address.');
    return;
  }

  document.getElementById('btn-label').textContent = 'Sending…';
  sendBtn.classList.add('loading');
  sendBtn.disabled = true;

  const ready = await waitForSB(6000);
  if (!ready) {
    document.getElementById('btn-label').textContent = 'Send Sign-In Link';
    sendBtn.classList.remove('loading');
    sendBtn.disabled = false;
    showError('Page failed to initialize. Please refresh and try again.');
    return;
  }

  try {
    const sb = getSB();

    const { data: { session: existing } } = await sb.auth.getSession();
    if (existing && existing.user.email.toLowerCase() !== email) {
      await sb.auth.signOut().catch(() => {});
    }

    const redirectUrl = new URL('/tenant/portal.html', window.location.origin);
    if (appId) redirectUrl.searchParams.set('app_id', appId);
    // Pass any "?redirect=/tenant/deposit.html" or "?next=…" through to the
    // magic-link callback so portal.html can re-route the tenant to the page
    // they were originally trying to use (deposit, inspection, etc.).
    const nextPath = readNextParam();
    if (nextPath) redirectUrl.searchParams.set('next', nextPath);

    // Try our branded magic-link sender first (sends through Choice Properties
    // Gmail SMTP, not Supabase's default unbranded template). Falls back to
    // the built-in Supabase magic link if the function is unavailable.
    let sentViaCustom = false;
    try {
      const fnUrl = `${CONFIG.SUPABASE_URL}/functions/v1/send-magic-link`;
      const resp = await fetch(fnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ email, redirectTo: redirectUrl.toString() }),
      });
      if (resp.ok) {
        sentViaCustom = true;
      } else if (resp.status === 429) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.message || 'Too many sign-in requests. Please wait a few minutes.');
      }
    } catch (customErr) {
      if (/Too many sign-in requests/.test(customErr.message || '')) throw customErr;
    }

    if (!sentViaCustom) {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectUrl.toString() },
      });
      if (error) throw error;
    }

    if (appId) sessionStorage.setItem('pendingPortalAppId', appId);
    showSuccessScreen(email);

  } catch (err) {
    document.getElementById('btn-label').textContent = 'Send Sign-In Link';
    sendBtn.classList.remove('loading');
    sendBtn.disabled = false;
    showError(parseSBError(err));
  }
}

async function signOutAndReset(prefillEmail) {
  try {
    const sb = getSB();
    await sb.auth.signOut();
  } catch (_) {}
  sessionStorage.removeItem('pendingPortalAppId');
  document.getElementById('signed-in-banner').classList.remove('visible');
  document.getElementById('wrong-account-notice').classList.remove('visible');
  document.getElementById('signout-btn').style.display = 'none';
  document.getElementById('login-form').style.display = 'block';
  document.getElementById('heading').textContent = 'Sign In';
  document.getElementById('subtitle').textContent = 'Enter your email to receive a secure sign-in link.';
  clearError();
  const params = new URLSearchParams(window.location.search);
  const emailParam = prefillEmail || params.get('email') || '';
  if (emailParam) document.getElementById('email').value = emailParam;
  document.getElementById('email').focus();
}

function goToPortal() {
  // If the tenant landed here via /tenant/login.html?redirect=/tenant/deposit.html
  // (or ?next=) — e.g. they were trying to use deposit.html or inspection.html
  // and got bounced because their session was missing — send them straight to
  // the page they were trying to reach instead of the portal home.
  const next = readNextParam();
  if (next) {
    window.location.href = next;
    return;
  }
  const portalUrl = new URL('/tenant/portal.html', window.location.origin);
  if (_pendingPortalAppId) portalUrl.searchParams.set('app_id', _pendingPortalAppId);
  window.location.href = portalUrl.pathname + portalUrl.search;
}

// ── Wire buttons ─────────────────────────────────────────────────────────────
document.getElementById('send-btn').addEventListener('click', () => sendMagicLink());
document.getElementById('email').addEventListener('keydown', e => { if (e.key === 'Enter') sendMagicLink(); });
document.getElementById('btn-continue').addEventListener('click', goToPortal);
document.getElementById('btn-switch').addEventListener('click', () => signOutAndReset());
document.getElementById('btn-switch-wrong').addEventListener('click', () => {
  const params = new URLSearchParams(window.location.search);
  signOutAndReset(params.get('email') || '');
});
document.getElementById('signout-btn').addEventListener('click', () => signOutAndReset());
document.getElementById('resend-btn').addEventListener('click', () => {
  const email = document.getElementById('success-email').textContent.trim();
  sendMagicLink(email);
});
document.getElementById('btn-wrong-email').addEventListener('click', () => {
  resetToForm('');
  document.getElementById('email').focus();
});

// ── Initialize — check existing session ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const appId = params.get('app_id') || sessionStorage.getItem('pendingPortalAppId') || '';
  const emailParam = params.get('email') || '';
  const needEmail = params.get('need_email') === '1';
  const linkError = params.get('link_error') || '';

  if (linkError) {
    const fe = document.getElementById('field-error');
    if (fe) {
      fe.textContent = 'Your sign-in link is no longer valid: ' + linkError + ' Please request a new one below.';
      fe.classList.add('visible');
    }
  }

  // Show a friendly banner when the tenant was redirected here because their session expired
  const reason = params.get('reason') || '';
  if (reason === 'session_expired') {
    const fe = document.getElementById('field-error');
    if (fe && !linkError) {
      fe.classList.remove('error');
      fe.classList.add('info', 'visible');
      fe.innerHTML = '<strong>Your session has expired.</strong> Enter your email below and we\'ll send you a new sign-in link instantly.';
    }
  }

  _pendingPortalAppId = appId;
  if (appId) sessionStorage.setItem('pendingPortalAppId', appId);
  if (emailParam) document.getElementById('email').value = emailParam;

  if (needEmail) {
    // SECURITY: emailParam comes from the URL query string, so it must be
    // HTML-escaped before it's pasted into innerHTML. Without esc() a link
    // like ?email=<img src=x onerror=…> would run script on the login page.
    const infoMsg = emailParam
      ? `Sign in with <strong>${esc(emailParam)}</strong> — the email on your rental application.`
      : 'Please sign in with the email address you used on your rental application.';
    const fe = document.getElementById('field-error');
    fe.classList.remove('error');
    fe.classList.add('info', 'visible');
    fe.innerHTML = infoMsg;
    document.getElementById('subtitle').textContent = 'Sign in with your application email to continue.';
  }

  const initOverlay = document.getElementById('init-overlay');
  initOverlay.style.display = 'flex';
  document.getElementById('send-btn').disabled = true;

  const ready = await waitForSB(8000);

  initOverlay.style.display = 'none';
  document.getElementById('send-btn').disabled = false;

  if (!ready) return;

  const sb = getSB();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;

  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) {
    await sb.auth.signOut().catch(() => {});
    sessionStorage.removeItem('pendingPortalAppId');
    return;
  }

  const signedInEmail = userData.user.email.toLowerCase();
  const requestedEmail = emailParam.toLowerCase();

  if (requestedEmail && signedInEmail !== requestedEmail) {
    const notice = document.getElementById('wrong-account-notice');
    // SECURITY: requestedEmail comes from the URL ?email= param. signedInEmail
    // comes from Supabase auth (trusted), but escape both for consistency.
    document.getElementById('wrong-account-msg').innerHTML =
      'You are currently signed in as <strong>' + esc(signedInEmail) + '</strong>. ' +
      'This application requires sign-in with <strong>' + esc(requestedEmail) + '</strong>.';
    notice.classList.add('visible');
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('heading').textContent = 'Wrong Account';
    document.getElementById('subtitle').textContent = 'Sign out and sign in with the correct email to continue.';
    return;
  }

  const banner = document.getElementById('signed-in-banner');
  document.getElementById('signed-in-email').textContent = signedInEmail;
  banner.classList.add('visible');
  document.getElementById('heading').textContent = 'Already Signed In';
  document.getElementById('subtitle').textContent = 'Choose what you\'d like to do.';
  document.getElementById('login-form').style.display = 'none';
});
