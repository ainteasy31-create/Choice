'use strict';

async function waitForSB(ms){
  const end=Date.now()+ms;
  while(Date.now()<end){
    if(window.supabase&&typeof CONFIG!=='undefined'&&CONFIG.SUPABASE_URL)return true;
    await new Promise(r=>setTimeout(r,80));
  }
  return false;
}

let _sb=null;
function getSB(){
  if(!_sb){
    _sb=window.supabase.createClient(CONFIG.SUPABASE_URL,CONFIG.SUPABASE_ANON_KEY,{
      auth:{
        persistSession:true,
        autoRefreshToken:true,
        // I-411: Was `true`. We manually parse all 3 magic-link URL shapes in
        // waitForMagicLinkSession() (hash tokens, token_hash, PKCE code). With
        // detectSessionInUrl ALSO on, the SDK silently consumed the hash on
        // load — then our manual setSession() raced it and one path always
        // failed, occasionally clearing the freshly-created session and
        // bouncing the user straight back to /tenant/login.html.
        detectSessionInUrl:false,
        // PKCE flow returns a refresh token so sessions survive past the 1-hour
        // JWT expiry — autoRefreshToken silently re-issues new access tokens.
        flowType:'pkce'
      }
    });
    // Quiets the SDK's internal background refresh failure logging.
    _sb.auth.onAuthStateChange(()=>{});
  }
  return _sb;
}

function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
function fmtDate(d){if(!d)return '—';try{return new Date(d).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});}catch{return d;}}
function fmtDateShort(d){if(!d)return '—';try{return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}catch{return d;}}
function fmtMoney(v){if(v==null)return '—';return '$'+Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}

// ── Time-of-day greeting (used by the property hero) ─────────────────────────
function greetingFor(name){
  const h = new Date().getHours();
  const t = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? t + ', ' + name : t;
}

// ── Relative time (Twitter-style) ────────────────────────────────────────────
function relTime(d){
  if(!d) return '';
  const ms = Date.now() - new Date(d).getTime();
  if(isNaN(ms)) return '';
  const s = Math.floor(ms/1000);
  if(s < 45)   return 'just now';
  if(s < 90)   return '1 min ago';
  const m = Math.floor(s/60);
  if(m < 45)   return m + ' min ago';
  if(m < 90)   return '1 hour ago';
  const h = Math.floor(m/60);
  if(h < 24)   return h + ' hours ago';
  if(h < 36)   return 'yesterday';
  const days = Math.floor(h/24);
  if(days < 7) return days + ' days ago';
  return fmtDateShort(d);
}

// ── Toast notifications ──────────────────────────────────────────────────────
function showToast(msg, kind, opts){
  kind = kind || 'info';
  opts = opts || {};
  const stack = document.getElementById('toast-stack');
  if(!stack) return;
  const iconMap = {success:'i-check', warn:'i-clock', danger:'i-x', info:'i-bell'};
  const icon = opts.icon || iconMap[kind] || 'i-bell';
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.setAttribute('role', kind === 'danger' || kind === 'warn' ? 'alert' : 'status');
  el.innerHTML = '<svg class="ico"><use href="#' + esc(icon) + '"/></svg><span>' + esc(msg) + '</span>';
  stack.appendChild(el);
  const dur = opts.duration || 3800;
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => { try{ stack.removeChild(el); }catch(_){} }, 280);
  }, dur);
}

// ── Theme management (light / auto / dark) ───────────────────────────────────
const THEME_KEY = 'cp-theme';
function applyTheme(mode){
  const root = document.documentElement;
  let resolved = mode;
  if(mode === 'auto'){
    resolved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', resolved);
  document.querySelectorAll('.theme-toggle button').forEach(b => {
    b.dataset.active = (b.dataset.mode === mode) ? '1' : '0';
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', resolved === 'dark' ? '#0b1020' : '#ffffff');
}
function initTheme(){
  const saved = (function(){ try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch(_) { return 'auto'; }})();
  // Inject the floating toggle (only if not already there)
  if(!document.querySelector('.theme-toggle')){
    const wrap = document.createElement('div');
    wrap.className = 'theme-toggle';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Theme');
    wrap.innerHTML =
      '<button type="button" data-theme-mode="light" aria-label="Light mode"><svg class="ico"><use href="#i-sun"/></svg></button>' +
      '<button type="button" data-theme-mode="auto"  aria-label="Auto theme"><svg class="ico"><use href="#i-spark"/></svg></button>' +
      '<button type="button" data-theme-mode="dark"  aria-label="Dark mode"><svg class="ico"><use href="#i-moon"/></svg></button>';
    document.body.appendChild(wrap);
    wrap.querySelectorAll('button').forEach(b => {
      b.dataset.mode = b.dataset.themeMode;
      b.addEventListener('click', () => {
        const m = b.dataset.themeMode;
        try { localStorage.setItem(THEME_KEY, m); } catch(_) {}
        applyTheme(m);
      });
    });
  }
  applyTheme(saved);
  // Re-apply when the OS theme changes (only relevant when in 'auto' mode)
  if(window.matchMedia){
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener && mq.addEventListener('change', () => {
        const cur = (function(){ try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch(_) { return 'auto'; }})();
        if(cur === 'auto') applyTheme('auto');
      });
    } catch(_) {}
  }
}

// ── Property fetch (photo + beds/baths) ──────────────────────────────────────
async function fetchProperty(propertyId){
  if(!propertyId) return null;
  try{
    const sb = getSB();
    const { data, error } = await sb
      .from('properties')
      .select('id,address,city,state,zip,bedrooms,bathrooms,property_type,property_photos(url,display_order)')
      .eq('id', propertyId)
      .maybeSingle();
    if(error || !data) return null;
    let photo = null;
    if(Array.isArray(data.property_photos) && data.property_photos.length){
      const sorted = data.property_photos.slice().sort((a,b)=>(a.display_order||0)-(b.display_order||0));
      photo = sorted[0]?.url || null;
    }
    return { ...data, _photo: photo };
  } catch(_) { return null; }
}

// ── Property hero render ─────────────────────────────────────────────────────
function renderPropertyHero(app, prop){
  const first = (app.first_name || '').trim();
  const greet = greetingFor(first);
  const photo = prop?._photo;
  const addr  = app.property_address ||
    [prop?.address, prop?.city && (prop.city + (prop.state ? ', ' + prop.state : ''))]
      .filter(Boolean).join(', ') || 'Your future home';
  const bedTxt  = prop?.bedrooms != null ? (prop.bedrooms + (prop.bedrooms === 1 ? ' bed' : ' beds')) : '';
  const bathTxt = prop?.bathrooms != null ? (prop.bathrooms + (prop.bathrooms === 1 ? ' bath' : ' baths')) : '';
  const stats = (bedTxt || bathTxt) ?
    '<div class="prop-hero-stats">' +
      (bedTxt  ? '<span><svg class="ico"><use href="#i-bed"/></svg>'  + esc(bedTxt)  + '</span>' : '') +
      (bathTxt ? '<span><svg class="ico"><use href="#i-bath"/></svg>' + esc(bathTxt) + '</span>' : '') +
    '</div>' : '';
  const imgPart = photo
    ? '<img class="prop-hero-img" src="' + esc(photo) + '" alt="' + esc(addr) + '" loading="eager" decoding="async" data-hero-fallback="1">'
    : '<div class="prop-hero-img is-placeholder">Your future home</div>';
  return '' +
    '<div class="prop-hero">' +
      imgPart +
      '<div class="prop-hero-overlay">' +
        '<div class="prop-hero-greet">' + esc(greet) + '</div>' +
        '<div class="prop-hero-title">Your application for this home is in motion.</div>' +
        '<div class="prop-hero-addr"><svg class="ico"><use href="#i-pin"/></svg>' + esc(addr) + '</div>' +
        stats +
      '</div>' +
    '</div>';
}

// ── Activity feed builder (synthesized from app date fields) ────────────────
function buildActivity(app){
  const items = [];
  const push = (when, kind, dot, text, sub) => {
    if(!when) return;
    items.push({ when: new Date(when), kind, dot, text, sub: sub || '' });
  };

  push(app.created_at, 'submit',  'success', 'Application submitted',
       'We received your rental application and locked in your place in the queue.');

  if(app.payment_status === 'paid' || app.payment_status === 'waived'){
    push(app.payment_date || app.payment_confirmed_at, 'fee', 'success',
      app.payment_status === 'waived' ? 'Application fee waived' : 'Application fee received',
      'Your application moved into active review.');
  }

  if(app.holding_fee_requested){
    push(app.updated_at, 'hf-req', 'warn', 'Holding fee requested',
      'A holding fee was requested to reserve your unit.');
  }
  if(app.holding_fee_paid && app.holding_fee_paid_at){
    push(app.holding_fee_paid_at, 'hf-paid', 'success', 'Holding fee received',
      'Your unit is now held for you.');
  }

  if(app.status === 'approved'){
    push(app.updated_at, 'approved', 'success', 'You were selected',
      'Congratulations — your application was approved.');
  }
  if(app.status === 'denied'){
    push(app.updated_at, 'denied', 'warn', 'Application decision recorded', '');
  }
  if(app.status === 'waitlisted'){
    push(app.updated_at, 'wait', 'purple', 'Added to the waitlist',
      'We will contact you the moment a unit opens up.');
  }
  if(app.status === 'withdrawn'){
    push(app.updated_at, 'wd', 'info', 'Application withdrawn', '');
  }

  if(app.lease_sent_date){
    push(app.lease_sent_date, 'lease-sent', 'info', 'Lease ready to sign',
      'Your lease was generated and sent for signature.');
  }
  if(app.lease_signed_date && (app.lease_status === 'signed' || app.lease_status === 'co_signed' || app.lease_status === 'awaiting_co_sign')){
    push(app.lease_signed_date, 'lease-signed', 'success', 'Lease signed',
      app.lease_status === 'awaiting_co_sign' ? 'We are now waiting on your co-applicant.' : 'Lease executed.');
  }

  if(app.move_in_date_actual && (app.move_in_status === 'confirmed' || app.move_in_status === 'completed')){
    push(app.move_in_date_actual, 'movein', 'success',
      app.move_in_status === 'completed' ? 'Move-in completed' : 'Move-in confirmed',
      'Welcome home.');
  }

  if(app.admin_notes){
    push(app.updated_at, 'note', 'info', 'A note from our team',
      app.admin_notes.length > 90 ? app.admin_notes.slice(0,87) + '…' : app.admin_notes);
  }

  // Most recent first; cap at 8 to keep the card focused.
  items.sort((a,b) => b.when - a.when);
  return items.slice(0, 8);
}

function renderActivityFeed(app){
  const items = buildActivity(app);
  if(!items.length) return '';
  const dotIcon = {
    success:'i-check', info:'i-bell', warn:'i-clock', purple:'i-bell'
  };
  const rows = items.map(it => {
    return '<li class="activity-item">' +
      '<span class="activity-dot ' + esc(it.dot) + '"><svg class="ico"><use href="#' + esc(dotIcon[it.dot]||'i-bell') + '"/></svg></span>' +
      '<div class="activity-body">' +
        '<div class="activity-text">' + esc(it.text) + '</div>' +
        (it.sub ? '<div class="activity-sub">' + esc(it.sub) + '</div>' : '') +
        '<div class="activity-time" title="' + esc(fmtDate(it.when)) + '">' + esc(relTime(it.when)) + '</div>' +
      '</div>' +
    '</li>';
  }).join('');
  return '<div class="activity">' +
    '<div class="activity-card">' +
      '<div class="activity-head">' +
        '<div class="activity-head-l">' +
          '<div class="activity-title">Activity</div>' +
        '</div>' +
        '<span class="live-pill" id="live-pill" data-state="off" title="Live updates">Live</span>' +
      '</div>' +
      '<ul class="activity-list">' + rows + '</ul>' +
    '</div>' +
  '</div>';
}

// ── Realtime: subscribe to this application's row for instant updates ───────
let _rtChannel = null;
function setupRealtime(sb, appPk, onChange){
  try{
    if(_rtChannel){ try { sb.removeChannel(_rtChannel); } catch(_) {} _rtChannel = null; }
    if(!appPk) return;
    _rtChannel = sb.channel('portal-app-' + appPk)
      .on('postgres_changes',
          { event:'UPDATE', schema:'public', table:'applications', filter:'id=eq.'+appPk },
          (payload) => { try { onChange && onChange(payload); } catch(_) {} })
      .subscribe((status) => {
        const pill = document.getElementById('live-pill');
        if(!pill) return;
        if(status === 'SUBSCRIBED'){
          pill.dataset.state = 'on';
          pill.title = 'Receiving live updates';
        } else if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){
          pill.dataset.state = 'off';
          pill.title = 'Live updates unavailable — refresh to see latest';
        }
      });
  } catch(_) {}
}

// ── Drag & drop on the doc card (desktop only via CSS visibility) ───────────
function setupDropzone(){
  const dz = document.getElementById('doc-dropzone');
  if(!dz) return;
  const onOver = (e) => { e.preventDefault(); dz.dataset.active = '1'; };
  const onLeave = () => { dz.dataset.active = '0'; };
  const onDrop = (e) => {
    e.preventDefault();
    dz.dataset.active = '0';
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if(!files.length) return;
    // Phase 2 — Single file: route to first empty required slot (legacy
    // behaviour). Multiple files: dump them all into the "other" bucket
    // as a single batched upload (the upload pipeline will fan them out
    // in parallel). We can't reliably auto-classify multiple files at
    // once and putting them all in one slot at least keeps them grouped.
    if(files.length === 1){
      routeDroppedFile(files[0]);
    } else {
      routeDroppedFiles(files, 'other');
    }
  };
  dz.addEventListener('dragover', onOver);
  dz.addEventListener('dragenter', onOver);
  dz.addEventListener('dragleave', onLeave);
  dz.addEventListener('drop', onDrop);
}
function routeDroppedFile(file){
  // Find first empty required slot, else 'other'.
  const cards = document.querySelectorAll('.doc-check[data-state="required"]');
  const target = cards[0] || document.querySelector('.doc-check[data-state="optional"]');
  if(!target) return;
  const input = target.querySelector('input[type=file][data-doc-type]');
  if(!input) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles:true }));
  showToast('Uploading ' + file.name + '…', 'info', { icon:'i-upload-cloud' });
}
function routeDroppedFiles(files, preferredType){
  // Find the input matching the preferred doc type (default 'other'); if
  // missing, just pick the first input that exists.
  let input = document.querySelector('input[type=file][data-doc-type="' + preferredType + '"]')
           || document.querySelector('input[type=file][data-doc-type]');
  if(!input) return;
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles:true }));
  showToast('Uploading ' + files.length + ' files…', 'info', { icon:'i-upload-cloud' });
}

async function signOut(){
  try { await getSB().auth.signOut(); } catch(_) {}
  sessionStorage.removeItem('pendingPortalAppId');
  location.href = '/tenant/login.html';
}

async function lookupByAppId(){
  const input=document.getElementById('manual-app-id');
  const msg=document.getElementById('appid-msg');
  if(!input||!msg)return;
  const appId=(input.value||'').trim().toUpperCase();
  if(!appId){msg.textContent='Please enter your Application ID.';msg.style.color='#a16207';msg.style.display='block';return;}
  msg.textContent='Looking up…';msg.style.color='var(--muted)';msg.style.display='block';
  try{
    const sb=getSB();
    const {data:{session}}=await sb.auth.getSession();
    const userEmail=(session?.user?.email||'').toLowerCase();
    const {data:claimResult,error:claimErr}=await sb.rpc('claim_application',{p_app_id:appId,p_email:userEmail});
    if(claimErr||claimResult?.success===false){
      msg.textContent='That Application ID was not found or does not match your email address. Please contact us for help.';
      msg.style.color='#b91c1c';msg.style.display='block';
      return;
    }
    sessionStorage.setItem('pendingPortalAppId',appId);
    location.href='/tenant/portal.html?app_id='+encodeURIComponent(appId);
  }catch(e){
    msg.textContent='Error: '+(e.message||'Could not look up application.');
    msg.style.color='#b91c1c';msg.style.display='block';
  }
}

// ── Payment status rendering ─────────────────────────────────────────────────
function renderPaymentStatus(app){
  const status=app.payment_status||'unpaid';
  const fee=app.application_fee;
  const paid=status==='paid';
  const waived=status==='waived';
  const refunded=status==='refunded';

  if(paid||waived){
    const lines=[];
    if(fee!=null)lines.push(`<div class="meta-item"><span class="meta-label">Application Fee</span><span class="meta-val">${fmtMoney(fee)}</span></div>`);
    lines.push(`<div class="meta-item"><span class="meta-label">Payment Status</span><span class="meta-val" style="color:#15803d">&#10003; ${paid?'Paid':waived?'Waived':''}</span></div>`);
    if(app.payment_date)lines.push(`<div class="meta-item"><span class="meta-label">Received</span><span class="meta-val">${fmtDateShort(app.payment_date)}</span></div>`);
    if(app.payment_amount_recorded)lines.push(`<div class="meta-item"><span class="meta-label">Amount</span><span class="meta-val">${fmtMoney(app.payment_amount_recorded)}</span></div>`);
    if(app.payment_method_recorded)lines.push(`<div class="meta-item"><span class="meta-label">Method</span><span class="meta-val">${esc(app.payment_method_recorded)}</span></div>`);
    return `<div class="section"><div class="section-label">Payment</div>
      <div class="payment-card"><div class="payment-title"><span style="font-size:1.1rem">&#10003;</span> Fee Confirmed</div>
      <div class="meta-grid">${lines.join('')}</div></div></div>`;
  }

  if(refunded){
    return `<div class="section"><div class="section-label">Payment</div>
      <div class="pay-unpaid-card"><div class="pay-unpaid-title">&#8592; Fee Refunded</div>
      <p style="color:var(--muted);font-size:.83rem">Your application fee has been refunded. Please contact us with any questions.</p></div></div>`;
  }

  if(status==='unpaid'&&fee){
    return `<div class="section"><div class="section-label">Payment</div>
      <div class="pay-unpaid-card">
        <div class="pay-unpaid-title">&#128176; Application Fee Due — ${fmtMoney(fee)}</div>
        <p style="color:var(--muted);font-size:.83rem;margin-bottom:8px">A $50 application fee is required after submission. Our team will contact you shortly to securely complete payment before your application is reviewed.</p>
        <p style="color:#1d4ed8;font-size:.78rem;margin-bottom:14px;font-weight:600">Applicants who complete payment quickly are placed earlier in the review queue.</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="font-size:.76rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:2px">Accepted payment methods</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <span style="padding:5px 12px;border-radius:8px;background:#dbeafe;color:#1d4ed8;font-size:.76rem;font-weight:600">Venmo</span>
            <span style="padding:5px 12px;border-radius:8px;background:#dbeafe;color:#1d4ed8;font-size:.76rem;font-weight:600">Zelle</span>
            <span style="padding:5px 12px;border-radius:8px;background:#dbeafe;color:#1d4ed8;font-size:.76rem;font-weight:600">Cash App</span>
            <span style="padding:5px 12px;border-radius:8px;background:#dbeafe;color:#1d4ed8;font-size:.76rem;font-weight:600">Money Order</span>
          </div>
          <p style="color:var(--muted);font-size:.76rem;margin-top:6px">Have questions or want to arrange payment now? <a href="tel:7077063137" style="color:#1d4ed8;font-weight:600">Call or text 707-706-3137</a></p>
        </div>
      </div></div>`;
  }

  // Holding fee flow
  if(app.holding_fee_requested){
    const hfPaid=app.holding_fee_paid;
    const hfAmt=app.holding_fee_amount;
    const hfDue=app.holding_fee_due_date;
    if(hfPaid){
      return `<div class="section"><div class="section-label">Payment</div>
        <div class="payment-card"><div class="payment-title"><span>&#10003;</span> Holding Fee Received</div>
        <div class="meta-grid">
          ${hfAmt?`<div class="meta-item"><span class="meta-label">Amount</span><span class="meta-val">${fmtMoney(hfAmt)}</span></div>`:''}
          ${app.holding_fee_paid_at?`<div class="meta-item"><span class="meta-label">Received</span><span class="meta-val">${fmtDateShort(app.holding_fee_paid_at)}</span></div>`:''}
        </div></div></div>`;
    }
    return `<div class="section"><div class="section-label">Reservation</div>
      <div class="pay-unpaid-card"><div class="pay-unpaid-title">&#128176; Holding Fee Requested${hfAmt?' — '+fmtMoney(hfAmt):''}</div>
      <p style="color:var(--text);font-size:.83rem;margin-bottom:8px;line-height:1.55">
        The holding fee temporarily reserves this property and removes it from active availability while your lease is being finalized.${hfDue?' Please complete by <strong>'+fmtDate(hfDue)+'</strong>.':''}
      </p>
      <p style="color:#b91c1c;font-size:.78rem;margin-bottom:8px;font-weight:600">Without a holding fee, the property remains available to other approved applicants. Holding requests are time-sensitive and typically must be completed within 24–48 hours.</p>
      <p style="color:#15803d;font-size:.78rem;margin-bottom:12px;font-weight:600">&#10003; This fee is fully credited toward your move-in costs — it is not an additional charge.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <span style="padding:5px 12px;border-radius:8px;background:#dbeafe;color:#1d4ed8;font-size:.76rem;font-weight:600">Venmo</span>
        <span style="padding:5px 12px;border-radius:8px;background:#dbeafe;color:#1d4ed8;font-size:.76rem;font-weight:600">Zelle</span>
        <span style="padding:5px 12px;border-radius:8px;background:#dbeafe;color:#1d4ed8;font-size:.76rem;font-weight:600">Cashier's Check</span>
      </div>
      <p style="color:var(--muted);font-size:.76rem">After payment, please call or text us to confirm: <a href="tel:7077063137" style="color:#1d4ed8;font-weight:600">707-706-3137</a></p></div></div>`;
  }

  return '';
}

// ── Documents submitted with the original application ────────────────────────
function renderSubmittedDocs(app){
  if(['denied','withdrawn'].includes(app.status)) return '';
  return `<div class="section" id="submitted-docs-section" style="display:none">
    <div class="section-label">Documents You Submitted</div>
    <div class="card" id="submitted-docs-card">
      <p style="color:var(--muted);font-size:.82rem;margin-bottom:10px">Files attached when you submitted your application. These are shared only with our leasing team.</p>
      <div id="submitted-docs-list" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
  </div>`;
}

async function loadSubmittedDocs(appId){
  try{
    const sb=getSB();
    const folder=appId+'/applicant_upload';
    const {data:files,error}=await sb.storage.from('application-docs')
      .list(folder,{limit:20,sortBy:{column:'created_at',order:'desc'}});
    if(error||!files||!files.length) return;
    const section=document.getElementById('submitted-docs-section');
    const list=document.getElementById('submitted-docs-list');
    if(!section||!list) return;
    list.innerHTML=files.map(f=>{
      const name=f.name||'document';
      const isPdf=/\.pdf$/i.test(name);
      const icon=isPdf?'&#128196;':'&#128247;';
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:var(--surface-2);border-radius:var(--r-md);border:1px solid var(--hairline)">
        <span style="display:flex;align-items:center;gap:8px;font-size:.83rem;font-weight:500;min-width:0">
          <span>${icon}</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
        </span>
        <button type="button" style="flex-shrink:0;font-size:.75rem;font-weight:600;color:#1d4ed8;background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px;white-space:nowrap"
          data-action="dl-submitted-doc" data-path="${esc(folder+'/'+name)}">Download</button>
      </div>`;
    }).join('');
    section.style.display='';
  } catch(_){}
}

async function downloadSubmittedDoc(path){
  try{
    const {data,error}=await getSB().storage.from('application-docs').createSignedUrl(path,300);
    if(error||!data?.signedUrl){showToast('Could not get download link','danger');return;}
    window.open(data.signedUrl,'_blank');
  }catch(e){showToast(e.message,'danger');}
}

// ── Document upload (checklist with live file list) ──────────────────────────
function renderDocUpload(app){
  if(['denied','withdrawn'].includes(app.status))return '';
  // Initial render with empty grouped object — populated async via populateDocChecklist().
  const checklist = renderDocChecklist({});
  return `<div class="section"><div class="section-label">Documents</div>
    <div class="card" id="doc-checklist-card" data-app-id="${esc(app.app_id)}">
      <p style="color:var(--muted);font-size:.82rem;margin-bottom:6px">PDF, JPG, or PNG accepted. Files are private and shared only with our team.</p>
      <div class="dropzone" id="doc-dropzone" data-active="0" aria-label="Drag and drop documents here">
        <svg class="ico"><use href="#i-upload-cloud"/></svg>
        <div><strong>Drag &amp; drop files here</strong> &middot; we'll route them to the right slot below.</div>
      </div>
      <div id="doc-checklist-list">${checklist}</div>
    </div></div>`;
}

// Phase 2: accepts an optional `prefetchedDocs` array (rows from
// application_documents, returned by the tenant_portal_state RPC). When
// supplied, we skip the storage.list round-trip entirely. When omitted,
// we fall back to listing the storage bucket (legacy path, still works
// even if the migration is not applied).
async function populateDocChecklist(appId, prefetchedDocs){
  const card = document.getElementById('doc-checklist-card');
  const list = document.getElementById('doc-checklist-list');
  if(!card || !list) return;
  const grouped = Array.isArray(prefetchedDocs)
    ? groupDocsFromTable(prefetchedDocs)
    : await loadUploadedDocsList(appId);
  list.innerHTML = renderDocChecklist(grouped);
  // Restamp the data-app-id attribute on each file input (uploadDoc reads it).
  list.querySelectorAll('input[type=file][data-doc-type]').forEach(el => {
    el.dataset.appId = appId;
  });
}

// Convert application_documents rows into the same shape that
// loadUploadedDocsList (storage list) returns: { docType: [{name}, ...] }.
function groupDocsFromTable(rows){
  const grouped = {};
  (rows || []).forEach(d => {
    const type = String(d.doc_type || '').toLowerCase();
    const key = REQUIRED_DOCS.find(x => x.type === type)?.type || 'other';
    const name = d.original_file_name || String(d.storage_path || '').split('/').pop() || 'document';
    (grouped[key] = grouped[key] || []).push({ name: name });
  });
  return grouped;
}

// ── Document upload (Phase 2: multi-file with parallel uploads) ─────────────
// uploadOneFile is the single-file primitive — signs an upload URL via the
// request-upload-url Edge Function and PUTs the file. Returns true/false.
// uploadDocFiles is the multi-file orchestrator: reads every file from the
// input, runs uploads in parallel (capped at 4 concurrent — polite to the
// signing function), shows live progress in the per-doc status line, and
// refreshes the checklist once all uploads settle.
async function uploadOneFile(docType, appId, file){
  if(!file) return { ok:false, name:'', error:'No file' };
  try {
    const { data:{ session } } = await getSB().auth.getSession();
    const token = session?.access_token;
    if(!token) return { ok:false, name:file.name, error:'Not signed in' };
    const res = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/request-upload-url', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey':CONFIG.SUPABASE_ANON_KEY, 'Authorization':'Bearer ' + token },
      body: JSON.stringify({ app_id:appId, file_name:file.name, file_type:file.type, doc_type:docType }),
    });
    const d = await res.json().catch(() => ({}));
    if(!res.ok || !d.signed_url) return { ok:false, name:file.name, error: d.error || ('HTTP ' + res.status) };
    const up = await fetch(d.signed_url, { method:'PUT', headers:{ 'Content-Type':file.type, 'x-upsert':'true' }, body:file });
    if(!up.ok) return { ok:false, name:file.name, error:'Upload PUT failed' };
    return { ok:true, name:file.name };
  } catch(e) {
    return { ok:false, name:file?.name || '', error:e.message };
  }
}

async function uploadDocFiles(docType, appId, inputId, statusId){
  const input  = document.getElementById(inputId);
  const status = document.getElementById(statusId);
  if(!input) return;
  const files = Array.from(input.files || []);
  if(!files.length) return;
  const total = files.length;
  if(status){
    status.style.color = '#1d4ed8';
    status.textContent = total === 1 ? 'Uploading…' : ('Uploading 0 / ' + total + '…');
  }

  const CONCURRENCY = 4;
  const queue = files.slice();
  let done = 0, failed = 0;
  const failures = [];
  const updateStatus = () => {
    if(!status || total <= 1) return;
    const seen = done + failed;
    status.textContent = 'Uploading ' + seen + ' / ' + total + (failed ? ' (' + failed + ' failed)' : '') + '…';
  };
  const worker = async () => {
    while(queue.length){
      const f = queue.shift();
      const r = await uploadOneFile(docType, appId, f);
      if(r.ok){ done++; } else { failed++; failures.push(r); }
      updateStatus();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  if(status){
    if(failed === 0){
      status.innerHTML = '&#10003; ' + (total === 1 ? esc(files[0].name) : (total + ' files uploaded'));
      status.style.color = 'var(--acc-success-text)';
      showToast(total === 1 ? (esc(files[0].name) + ' uploaded') : (total + ' files uploaded'), 'success');
    } else if(done === 0){
      status.textContent = total === 1 ? 'Upload failed. Try again.' : 'All ' + total + ' uploads failed.';
      status.style.color = 'var(--acc-danger-text)';
      showToast(failures[0]?.error || 'Upload failed. Try again.', 'danger');
    } else {
      status.innerHTML = '&#10003; ' + done + ' uploaded · ' + failed + ' failed';
      status.style.color = 'var(--acc-warn-text)';
      showToast(done + ' uploaded, ' + failed + ' failed', 'warn');
    }
  }
  input.value = '';
  if(window._portalAppId) populateDocChecklist(window._portalAppId);
}

// Back-compat alias — older code paths referenced uploadDoc().
async function uploadDoc(docType, appId, inputId, statusId){
  return uploadDocFiles(docType, appId, inputId, statusId);
}

// ── Required documents (also used by checklist + uploader) ──────────────────
const REQUIRED_DOCS = [
  { type:'government_id',  label:'Government ID',          required:true,  hint:"Driver's license, passport, or state ID" },
  { type:'pay_stub',       label:'Pay Stub (last 2 months)', required:true, hint:'Most recent 2 months of pay stubs' },
  { type:'bank_statement', label:'Bank Statement',         required:true,  hint:'Most recent statement' },
  { type:'other',          label:'Other Document',         required:false, hint:'Optional supporting documents' },
];

// ── Next-step decision engine ─────────────────────────────────────────────────
// Returns { tone, eyebrow, title, sub, ctaLabel, ctaHref, ctaAction, deadline }
function nextStepFor(app){
  const status      = app.status || 'pending';
  const lease       = app.lease_status || 'none';
  const mi          = app.move_in_status || null;
  const payStatus   = app.payment_status || 'unpaid';
  const hfReq       = !!app.holding_fee_requested;
  const hfPaid      = !!app.holding_fee_paid;

  // Move-in done — it's home time.
  if(mi === 'completed' || mi === 'confirmed'){
    return { tone:'success', eyebrow:'You\'re all set', title:'Welcome home.',
      sub: app.move_in_date_actual
        ? 'Move-in date: ' + fmtDate(app.move_in_date_actual) + '. We\'ll be in touch with key pickup details.'
        : 'Your move-in is confirmed. We\'ll be in touch with key pickup details.' };
  }

  // Lease awaiting tenant signature
  if(lease === 'sent' && app.tenant_sign_token){
    return { tone:'info', eyebrow:'Action required', title:'Your lease is ready to sign.',
      sub:'Please review and sign as soon as possible — your move-in date depends on it.',
      ctaLabel:'Sign your lease', ctaHref:'/lease-sign.html?token=' + encodeURIComponent(app.tenant_sign_token),
      ctaIcon:'i-edit',
      deadline: app.lease_sent_date ? new Date(new Date(app.lease_sent_date).getTime() + 1000*60*60*48).toISOString() : null,
      deadlineLabel:'48-hr signing window' };
  }
  if(lease === 'awaiting_co_sign'){
    return { tone:'info', eyebrow:'Almost there', title:'Waiting on your co-applicant.',
      sub:'You\'ve signed — we\'re waiting for your co-applicant to complete their signature.' };
  }
  if(lease === 'signed' || lease === 'co_signed'){
    return { tone:'success', eyebrow:'Lease executed', title:'Your lease is signed.',
      sub: app.lease_start_date ? 'Lease starts ' + fmtDate(app.lease_start_date) + '. Move-in details to follow.' : 'Move-in scheduling next. Your team will be in touch.',
      ctaLabel:'Download lease', ctaAction:'download-lease', ctaIcon:'i-download' };
  }

  // Holding fee
  if(hfReq && !hfPaid){
    return { tone:'warn', eyebrow:'Time-sensitive', title:'Complete your holding fee to reserve the unit.',
      sub: (app.holding_fee_amount ? 'Amount: ' + fmtMoney(app.holding_fee_amount) + '. ' : '') +
           'This is fully credited toward your move-in costs. Without it, the unit remains available to other approved applicants.',
      ctaLabel:'Call to confirm payment', ctaHref:'tel:7077063137', ctaIcon:'i-dollar',
      deadline: app.holding_fee_due_date || null, deadlineLabel:'Due' };
  }
  if(hfPaid && lease === 'none'){
    return { tone:'info', eyebrow:'Reserved', title:'Holding fee received — your unit is held.',
      sub:'We\'re preparing your lease now. You\'ll be notified the moment it\'s ready to sign.' };
  }

  // Approved, no holding fee in motion yet
  if(status === 'approved'){
    return { tone:'success', eyebrow:'You were selected', title:'You\'ve been approved.',
      sub:'Your team will reach out shortly with next steps to reserve the unit and prepare your lease.' };
  }

  // Application fee unpaid
  if(payStatus === 'unpaid' && app.application_fee){
    return { tone:'warn', eyebrow:'Action required', title:'Application fee due — ' + fmtMoney(app.application_fee) + '.',
      sub:'Applications enter the active review queue once the fee is received. Faster payment means faster review.',
      ctaLabel:'Call to pay', ctaHref:'tel:7077063137', ctaIcon:'i-dollar' };
  }

  if(status === 'waitlisted'){
    return { tone:'purple', eyebrow:'On waitlist', title:'You\'re on the waitlist.',
      sub:'We\'ll contact you the moment a unit opens up. Browsing other listings in the meantime is welcome.' };
  }
  if(status === 'denied'){
    return { tone:'danger', eyebrow:'Decision', title:'Application not approved.',
      sub:'You\'re welcome to apply for other available properties.',
      ctaLabel:'Browse properties', ctaHref:'/listings.html', ctaIcon:'i-arrow' };
  }
  if(status === 'withdrawn'){
    return { tone:'info', eyebrow:'Withdrawn', title:'This application has been withdrawn.',
      sub:'If you\'d like to reapply in the future, we\'re here to help.' };
  }

  // Default — pending review
  return { tone:'info', eyebrow:'In review', title:'Your application is being reviewed.',
    sub:'Decisions typically come within 24–72 hours of payment confirmation. Applicants who respond promptly are often prioritized.' };
}

// ── Countdown badge ──────────────────────────────────────────────────────────
function countdownHtml(deadlineISO, label){
  if(!deadlineISO) return '';
  return `<span class="countdown" data-deadline="${esc(deadlineISO)}" data-label="${esc(label||'')}">
    <svg class="ico"><use href="#i-clock"/></svg><span class="cd-text">…</span>
  </span>`;
}
function tickCountdown(el){
  const deadline = new Date(el.dataset.deadline).getTime();
  if(isNaN(deadline)) return;
  const now = Date.now();
  const diff = deadline - now;
  const label = el.dataset.label || '';
  const txt = el.querySelector('.cd-text');
  if(diff <= 0){
    el.dataset.expired = '1';
    el.dataset.urgent = '0';
    if(txt) txt.textContent = (label ? label + ' · ' : '') + 'Past due';
    return;
  }
  const hrs = diff / (1000*60*60);
  el.dataset.urgent = (hrs <= 12) ? '1' : '0';
  el.dataset.expired = '0';
  let str;
  if(hrs >= 24){
    const d = Math.floor(hrs / 24);
    const h = Math.floor(hrs - d*24);
    str = d + 'd ' + h + 'h left';
  } else if(hrs >= 1){
    const h = Math.floor(hrs);
    const m = Math.floor((diff - h*1000*60*60) / (1000*60));
    str = h + 'h ' + m + 'm left';
  } else {
    const m = Math.max(1, Math.ceil(diff / (1000*60)));
    str = m + 'm left';
  }
  if(txt) txt.textContent = (label ? label + ' · ' : '') + str;
}
let _cdTimer = null;
function startCountdownTickers(root){
  if(_cdTimer){ clearInterval(_cdTimer); _cdTimer = null; }
  const els = (root || document).querySelectorAll('.countdown[data-deadline]');
  if(!els.length) return;
  els.forEach(tickCountdown);
  _cdTimer = setInterval(() => {
    document.querySelectorAll('.countdown[data-deadline]').forEach(tickCountdown);
  }, 30000);
}

// ── Hero block ───────────────────────────────────────────────────────────────
function renderHero(app, step){
  const cta = step.ctaLabel
    ? (step.ctaHref
        ? `<a class="hero-cta" href="${esc(step.ctaHref)}"><svg class="ico ico-lg"><use href="#${esc(step.ctaIcon||'i-arrow')}"/></svg>${esc(step.ctaLabel)}</a>`
        : `<button class="hero-cta" type="button" data-action="${esc(step.ctaAction||'')}"><svg class="ico ico-lg"><use href="#${esc(step.ctaIcon||'i-arrow')}"/></svg>${esc(step.ctaLabel)}</button>`)
    : '';
  const cd = step.deadline ? countdownHtml(step.deadline, step.deadlineLabel) : '';
  // Tone-appropriate hero icon (defaults to step.ctaIcon, then a tone-based fallback).
  const toneIconMap = {success:'i-check', warn:'i-clock', danger:'i-x', info:'i-bell', purple:'i-bell'};
  const heroIcon = step.heroIcon || step.ctaIcon || toneIconMap[step.tone] || 'i-bell';
  return `<div class="hero" data-tone="${esc(step.tone||'info')}">
    <div class="hero-icon"><svg class="ico"><use href="#${esc(heroIcon)}"/></svg></div>
    <div class="hero-eyebrow">${esc(step.eyebrow||'')}${cd?' &nbsp;'+cd:''}</div>
    <div class="hero-title">${esc(step.title||'')}</div>
    <div class="hero-sub">${esc(step.sub||'')}</div>
    ${cta}
  </div>`;
}

// ── Progress bar ─────────────────────────────────────────────────────────────
function renderProgress(steps){
  const totalUnits = steps.length;
  let done = 0;
  steps.forEach(s => { if(s.done) done++; });
  // Half-credit for the active step.
  const active = steps.find(s => s.active && !s.done);
  const pct = Math.round(((done + (active ? 0.5 : 0)) / totalUnits) * 100);
  const labelIdx = active ? steps.indexOf(active) + 1 : done;
  return `<div class="progress-wrap">
    <div class="progress-row"><span>Step ${labelIdx} of ${totalUnits}</span><span>${pct}%</span></div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
      <div class="progress-fill" style="width:${pct}%"></div>
    </div>
  </div>`;
}

// ── Uploaded documents (live list from storage) ──────────────────────────────
async function loadUploadedDocsList(appId){
  try{
    const sb = getSB();
    const { data:files, error } = await sb.storage.from('application-docs')
      .list(appId, { limit:100, sortBy:{ column:'created_at', order:'desc' } });
    if(error) return {};
    const grouped = {};
    (files||[]).forEach(f => {
      // Convention used by request-upload-url: <doc_type>_<timestamp>_<original>
      const m = (f.name||'').match(/^([a-z_]+?)(?:_\d+)?[_-]/i) || (f.name||'').match(/^([a-z_]+)/i);
      const type = (m && m[1]) ? m[1].toLowerCase() : 'other';
      const key = REQUIRED_DOCS.find(d => d.type === type)?.type || 'other';
      (grouped[key] = grouped[key] || []).push(f);
    });
    return grouped;
  } catch(_){ return {}; }
}

function renderDocChecklist(grouped){
  return REQUIRED_DOCS.map(d => {
    const files = grouped[d.type] || [];
    const has = files.length > 0;
    const state = has ? 'done' : (d.required ? 'required' : 'optional');
    const icon = has ? '<svg class="ico"><use href="#i-check"/></svg>' : (d.required ? '!' : '+');
    const statusText = has
      ? files.length + ' file' + (files.length!==1?'s':'') + ' uploaded'
      : (d.required ? 'Required · ' + d.hint : 'Optional · ' + d.hint);
    const filesList = has
      ? `<div class="doc-check-files">${files.slice(0,3).map(f =>
          `<span class="doc-check-file"><svg class="ico"><use href="#i-doc"/></svg>${esc(f.name)}</span>`
        ).join('')}${files.length>3?`<span class="doc-check-file" style="color:var(--muted)">+ ${files.length-3} more</span>`:''}</div>`
      : '';
    const btnLabel = has ? 'Replace' : (d.required ? 'Upload' : 'Add');
    const camId = 'cam-' + d.type;
    return `<div class="doc-check" data-state="${state}" style="position:relative">
      <button class="cam-btn" type="button" data-action="choose-file" data-target="${camId}" aria-label="Take photo for ${esc(d.label)}">
        <svg class="ico"><use href="#i-cam"/></svg>
      </button>
      <span class="doc-check-icon">${icon}</span>
      <div class="doc-check-body">
        <div class="doc-check-label">${esc(d.label)}</div>
        <div class="doc-check-status">${statusText}</div>
        ${filesList}
      </div>
      <input type="file" id="fi-${esc(d.type)}" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple style="display:none"
        data-doc-type="${esc(d.type)}" data-status-id="ds-${esc(d.type)}">
      <input type="file" id="${camId}" accept="image/*" capture="environment" style="display:none"
        data-doc-type="${esc(d.type)}" data-status-id="ds-${esc(d.type)}">
      <button class="btn-choose-mini" type="button" data-action="choose-file" data-target="fi-${esc(d.type)}">${btnLabel}</button>
    </div>
    <div class="doc-status" id="ds-${esc(d.type)}" style="font-size:.74rem;padding:0 0 6px 40px"></div>`;
  }).join('');
}

// ── Portal render ─────────────────────────────────────────────────────────────
function renderPortal(app){
  const name=esc(((app.first_name||'')+' '+(app.last_name||'')).trim())||'Applicant';
  const prop=esc(app.property_address||'Your Property');
  const status=app.status||'pending';
  const leaseStatus=app.lease_status||'none';
  const miStatus=app.move_in_status||null;

  const statusBadge=(s)=>{
    const m={pending:'b-pending',approved:'b-approved',denied:'b-denied',waitlisted:'b-waitlisted',withdrawn:'b-withdrawn'};
    const l={pending:'In Active Review',approved:'Selected',denied:'Not Approved',waitlisted:'Waitlisted',withdrawn:'Withdrawn'};
    return `<span class="badge ${m[s]||'b-none'}">${l[s]||s}</span>`;
  };
  const leaseBadge=(s)=>{
    if(!s||s==='none')return `<span class="badge b-none">No Lease</span>`;
    const l={sent:'Lease Sent',signed:'Lease Signed',co_signed:'Fully Executed',awaiting_co_sign:'Awaiting Co-Sign',voided:'Voided',expired:'Expired'};
    return `<span class="badge b-sent">${l[s]||s}</span>`;
  };

  // Pipeline steps
  const steps=[
    {
      done:true,label:'Application Submitted',
      sub:'Received '+fmtDateShort(app.created_at),
    },
    {
      done:['approved','denied'].includes(status),
      active:status==='pending'||status==='waitlisted',
      label:status==='approved'?'You Have Been Selected':status==='denied'?'Application Decision':status==='waitlisted'?'On Waitlist':'In Active Review',
      sub:status==='approved'?'You have been selected based on your application. This selection is time-sensitive — units are offered on a first-completion basis among approved applicants. Please complete the next steps promptly.':status==='denied'?'Your application was not approved at this time.':status==='waitlisted'?'You are on our waitlist. We will contact you when a unit becomes available.':'Your application is being evaluated for selection. Decisions are typically made within 24 to 72 hours of payment confirmation — applicants who respond promptly are often prioritized.',
    },
    {
      done:['signed','co_signed'].includes(leaseStatus),
      active:leaseStatus==='sent'||leaseStatus==='awaiting_co_sign',
      label:leaseStatus==='co_signed'?'Lease Fully Executed':leaseStatus==='signed'?'Lease Signed':leaseStatus==='sent'?'Lease Ready to Sign':leaseStatus==='awaiting_co_sign'?'Awaiting Co-Signature':'Lease Agreement',
      sub:leaseStatus==='co_signed'?'All parties have signed — fully executed.':leaseStatus==='signed'?'Signed on '+fmtDateShort(app.lease_signed_date):leaseStatus==='sent'?'Your lease is ready. Please sign as soon as possible.':leaseStatus==='awaiting_co_sign'?'Waiting for your co-applicant to sign.':'Will be prepared after approval.',
    },
    {
      done:miStatus==='confirmed'||miStatus==='completed',
      active:miStatus==='scheduled',
      label:miStatus==='confirmed'?'Move-In Confirmed':miStatus==='scheduled'?'Move-In Scheduled':'Move-In',
      sub:app.move_in_date_actual?'Date: '+fmtDate(app.move_in_date_actual):app.lease_start_date?'Lease starts '+fmtDate(app.lease_start_date):'To be scheduled after lease is signed.',
    },
  ];

  const stepsHtml=steps.map((s,i)=>{
    const cls=s.done?'step-done':s.active?'step-active':'step-wait';
    const icon=s.done
      ?'<svg class="ico"><use href="#i-check"/></svg>'
      :s.active
        ?'<svg class="ico"><use href="#i-clock"/></svg>'
        :String(i+1);
    return `<li class="step-item">
      <span class="step-icon ${cls}">${icon}</span>
      <div><div class="step-text">${s.label}</div><div class="step-sub">${s.sub}</div></div>
    </li>`;
  }).join('');

  const nextStep = nextStepFor(app);
  const heroHtml = renderHero(app, nextStep);
  const progressHtml = renderProgress(steps);

  // Lease actions
  let leaseHtml='';
  if(leaseStatus==='sent'&&app.tenant_sign_token){
    leaseHtml=`<div class="lease-section"><a href="/lease-sign.html?token=${esc(app.tenant_sign_token)}" class="btn-sign">&#9998; Sign Your Lease</a></div>`;
  } else if(leaseStatus==='signed'||leaseStatus==='co_signed'){
    leaseHtml=`<div class="lease-section"><button class="btn-download" type="button" data-action="download-lease">&#8595; Download Lease</button></div>`;
  }

  // Phase 8 closeout — Move-in / move-out inspection wizard CTA.
  // Surfaced once the lease is fully executed so tenants can document
  // the property's condition with photos. Required by 9 states to
  // protect the security deposit at move-out.
  if(leaseStatus==='co_signed' && app.id){
    leaseHtml += `<div class="lease-section" style="margin-top:var(--sp-3)">`
      + `<a href="/tenant/inspection.html?app=${esc(app.id)}&type=move_in" class="btn-sign" style="background:linear-gradient(135deg,#0891b2,#06b6d4);box-shadow:0 4px 14px rgba(8,145,178,.25)">`
      +   `&#128247; Complete Move-In Inspection`
      + `</a>`
      + `<div style="font-size:.76rem;color:var(--muted);margin-top:8px;text-align:center;line-height:1.5">`
      +   `Document the property's condition with photos before move-in. Required to protect your security deposit in many states.`
      + `</div>`
      + `</div>`;
  }

  // Denied card
  let deniedHtml='';
  if(status==='denied'){
    deniedHtml=`<div class="denied-card">
      <div class="denied-title">Application Not Approved</div>
      <p style="color:#7f1d1d;font-size:.85rem;line-height:1.65;margin-bottom:10px">We were unable to move forward with your application at this time based on our standard screening criteria.</p>
      <p style="color:var(--muted);font-size:.82rem;line-height:1.65">You are welcome to apply for other available properties. Browse our listings or call us at <strong style="color:var(--text)">707-706-3137</strong> to discuss your options.</p>
      <a href="/" style="display:inline-flex;align-items:center;gap:6px;margin-top:12px;padding:8px 16px;background:#dbeafe;border:1px solid #bfdbfe;color:#1d4ed8;border-radius:8px;font-size:.8rem;font-weight:600;text-decoration:none">View Available Properties &rarr;</a>
    </div>`;
  }

  // Waitlisted card
  let waitlistHtml='';
  if(status==='waitlisted'){
    waitlistHtml=`<div class="waitlist-card">
      <div class="waitlist-title">You're on the Waitlist</div>
      <p style="color:#581c87;font-size:.85rem;line-height:1.65">You have been added to the waitlist for this property. We will contact you as soon as it becomes available or a comparable unit opens up.</p>
      <p style="color:var(--muted);font-size:.82rem;margin-top:8px">In the meantime, feel free to browse our other available listings. Questions? Call <strong style="color:var(--text)">707-706-3137</strong>.</p>
    </div>`;
  }

  // Move-in card
  let moveInHtml='';
  if(miStatus==='confirmed'||miStatus==='scheduled'){
    moveInHtml=`<div class="section"><div class="section-label">Move-In Details</div>
      <div class="movein-card">
        <div class="movein-title">${miStatus==='confirmed'?'&#10003; Move-In Confirmed':'&#128197; Move-In Scheduled'}</div>
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-label">Move-In Date</span><span class="meta-val">${fmtDate(app.move_in_date_actual||app.lease_start_date)}</span></div>
          <div class="meta-item"><span class="meta-label">Property</span><span class="meta-val">${esc(app.property_address||'—')}</span></div>
          ${app.monthly_rent?`<div class="meta-item"><span class="meta-label">Monthly Rent</span><span class="meta-val">${fmtMoney(app.monthly_rent)}</span></div>`:''}
          ${app.move_in_notes?`<div class="meta-item" style="grid-column:1/-1"><span class="meta-label">Notes from Team</span><span class="meta-val" style="font-weight:400;color:var(--muted)">${esc(app.move_in_notes)}</span></div>`:''}
        </div>
      </div></div>`;
  }

  const withdrawHtml=(status==='pending'&&leaseStatus==='none')
    ?`<button class="btn-withdraw" type="button" data-action="withdraw">&#215; Withdraw Application</button>`:'';

  // Admin notes — visible message from the team
  const adminNotesHtml=app.admin_notes
    ?`<div class="section"><div class="section-label">Message from our team</div>
      <div class="card" style="background:#eff6ff;border:1px solid #bfdbfe;padding:16px 20px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:1rem">&#128172;</span>
          <span style="font-size:.75rem;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.06em">Note from Choice Properties</span>
        </div>
        <p style="color:var(--text);font-size:.88rem;line-height:1.7;white-space:pre-wrap">${esc(app.admin_notes)}</p>
      </div></div>`
    :'';

  return `
    <div id="prop-hero-slot"><div class="prop-hero"><div class="prop-hero-skel"></div></div></div>
    ${heroHtml}
    <div class="section">
      <div class="section-label">Your Application</div>
      <div class="card">
        <div class="status-header">
          <div>
            <div class="status-name">${name}</div>
            <div class="status-prop"><svg class="ico" style="color:var(--muted)"><use href="#i-pin"/></svg>${prop}</div>
          </div>
          <div class="badges-group">${statusBadge(status)}${leaseBadge(leaseStatus)}</div>
        </div>
        ${progressHtml}
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-label">App ID</span><span class="meta-val" style="font-family:monospace;font-size:.78rem">${esc(app.app_id||app.id)}</span></div>
          <div class="meta-item"><span class="meta-label">Submitted</span><span class="meta-val">${fmtDateShort(app.created_at)}</span></div>
          ${app.lease_start_date?`<div class="meta-item"><span class="meta-label">Lease Start</span><span class="meta-val">${fmtDateShort(app.lease_start_date)}</span></div>`:''}
          ${app.lease_end_date?`<div class="meta-item"><span class="meta-label">Lease End</span><span class="meta-val">${fmtDateShort(app.lease_end_date)}</span></div>`:''}
          ${app.monthly_rent?`<div class="meta-item"><span class="meta-label">Monthly Rent</span><span class="meta-val">${fmtMoney(app.monthly_rent)}</span></div>`:''}
          ${app.security_deposit?`<div class="meta-item"><span class="meta-label">Security Deposit</span><span class="meta-val">${fmtMoney(app.security_deposit)}</span></div>`:''}
        </div>
        <hr class="divider">
        <div class="pipeline-label">Application Status</div>
        <ul class="step-list">${stepsHtml}</ul>
        ${leaseHtml}
        ${deniedHtml}
        ${waitlistHtml}
        ${withdrawHtml}
      </div>
    </div>
    ${adminNotesHtml}
    ${moveInHtml}
    ${renderPaymentStatus(app)}
    ${renderSubmittedDocs(app)}
    ${renderDocUpload(app)}
    ${renderActivityFeed(app)}
    <div class="trust-strip" aria-label="Privacy and security">
      <span><svg class="ico"><use href="#i-shield"/></svg>Documents encrypted in transit &amp; at rest</span>
      <span><svg class="ico"><use href="#i-check"/></svg>Identity verified securely</span>
      <span><svg class="ico"><use href="#i-spark"/></svg>Live updates from your team</span>
    </div>
    <div class="portal-footer">
      Questions? <a href="mailto:support@choiceproperties.com">support@choiceproperties.com</a> &middot; <a href="tel:7077063137">707-706-3137</a>
    </div>`;
}

async function downloadLease(){
  try{
    const {data:sd}=await getSB().auth.getSession();
    const token=sd?.session?.access_token;
    if(!token){alert('Please sign in again.');return;}
    const res=await fetch(CONFIG.SUPABASE_URL+'/functions/v1/download-lease',{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':CONFIG.SUPABASE_ANON_KEY,'Authorization':'Bearer '+token},
      body:JSON.stringify({app_id:window._portalAppId}),
    });
    const d=await res.json();
    const signedUrl=d.signed_url||d.signedUrl;
    if(signedUrl)window.open(signedUrl,'_blank');
    else alert(d.error||'Could not get download link.');
  }catch(e){alert(e.message);}
}

async function withdrawApplication(){
  if(!confirm('Are you sure you want to withdraw your application?\n\nThis cannot be undone.'))return;
  const sb=getSB();
  const {data:{session}}=await sb.auth.getSession();
  const userEmail=(session?.user?.email||'').toLowerCase();
  if(window._portalAppId&&userEmail){
    await sb.rpc('claim_application',{p_app_id:window._portalAppId,p_email:userEmail}).catch(()=>{});
  }
  const {error}=await sb.from('applications').update({status:'withdrawn',updated_at:new Date().toISOString()}).eq('app_id',window._portalAppId);
  if(error){
    const ct=document.getElementById('portal-content');
    if(ct)ct.innerHTML=`<div class="error-card">We couldn't process your withdrawal automatically. Please contact us directly:<br><br>
      <a href="tel:7077063137" style="color:#1d4ed8;font-weight:700">&#128222; 707-706-3137</a> &nbsp;&middot;&nbsp;
      <a href="mailto:support@choiceproperties.com" style="color:#1d4ed8">support@choiceproperties.com</a><br><br>
      Reference: <span style="font-family:monospace">${esc(window._portalAppId||'')}</span></div>`;
    return;
  }
  try{
    await sb.from('admin_actions').insert({action:'tenant_withdraw',target_type:'application',target_id:window._portalAppId,metadata:{app_id:window._portalAppId,actor:session?.user?.email||'tenant'}});
  }catch(_){}
  try{
    if(session?.access_token){
      fetch(CONFIG.SUPABASE_URL+'/functions/v1/send-email',{
        method:'POST',
        headers:{'Content-Type':'application/json','apikey':CONFIG.SUPABASE_ANON_KEY,'Authorization':'Bearer '+session.access_token},
        body:JSON.stringify({type:'custom',to:'support@choiceproperties.com',subject:'Application Withdrawn — '+window._portalAppId,html:`<p>Application <strong>${window._portalAppId}</strong> has been withdrawn by the tenant (${esc(session.user?.email||'')}).</p>`}),
      }).catch(()=>{});
    }
  }catch(_){}
  document.getElementById('portal-content').innerHTML=`<div class="card" style="text-align:center;padding:36px">
    <div style="font-size:2.2rem;margin-bottom:14px;color:#15803d">&#10003;</div>
    <h3 style="color:var(--text);margin-bottom:8px">Application Withdrawn</h3>
    <p style="color:var(--muted);font-size:.88rem;line-height:1.65">Your application has been withdrawn. If you'd like to reapply in the future, please contact us at <a href="tel:7077063137" style="color:#1d4ed8">707-706-3137</a>.</p>
  </div>`;
}

// ── Auto-claim applications linked by email ──────────────────────────────────
async function autoClaimApplications(sb, userEmail){
  try{
    const {data:lookupResult,error}=await sb.rpc('get_apps_by_email',{p_email:userEmail});
    if(error||!lookupResult)return;
    const apps=typeof lookupResult==='string'?JSON.parse(lookupResult):lookupResult;
    if(!Array.isArray(apps)||!apps.length)return;
    for(const a of apps){
      if(a.app_id){
        await sb.rpc('claim_application',{p_app_id:a.app_id,p_email:userEmail}).catch(()=>{});
      }
    }
  }catch(_){}
}

function getRequestedAppId(){
  const params=new URLSearchParams(window.location.search);
  const appId=(params.get('app_id')||sessionStorage.getItem('pendingPortalAppId')||'').trim();
  if(appId)sessionStorage.setItem('pendingPortalAppId',appId);
  return appId;
}

async function signOutAndRetry(){
  const requestedAppId=getRequestedAppId();
  try{await getSB().auth.signOut();}catch(_){}
  sessionStorage.removeItem('pendingPortalAppId');
  const loginUrl=new URL('/tenant/login.html',window.location.origin);
  if(requestedAppId)loginUrl.searchParams.set('app_id',requestedAppId);
  loginUrl.searchParams.set('need_email','1');
  location.href=loginUrl.pathname+loginUrl.search;
}

async function redirectWrongAccount(requestedAppId){
  const loginUrl=new URL('/tenant/login.html',window.location.origin);
  if(requestedAppId)loginUrl.searchParams.set('app_id',requestedAppId);
  loginUrl.searchParams.set('need_email','1');
  try{await getSB().auth.signOut();}catch(_){}
  sessionStorage.removeItem('pendingPortalAppId');
  location.href=loginUrl.pathname+loginUrl.search;
}

function renderWrongAccount(userEmail, requestedAppId, message){
  return `<div class="no-app">
    <h3>Wrong account signed in</h3>
    <p style="color:var(--muted);font-size:.88rem;line-height:1.65">
      This application link is for a different email address.<br><br>
      You are currently signed in as <strong style="color:var(--text)">${esc(userEmail)}</strong>.
      Please sign in with the email address you used when filling out the rental application.
    </p>
    <button class="btn-withdraw" type="button" data-action="signout-retry" style="margin-top:18px">&#8592; Sign in with the correct email</button>
    ${requestedAppId?`<p style="margin-top:12px;font-size:.78rem;color:var(--muted)">Application: <span style="font-family:monospace">${esc(requestedAppId)}</span></p>`:''}
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
      <p style="font-size:.78rem;color:var(--muted);margin-bottom:6px"><strong style="color:var(--text)">Co-applicant?</strong> Sign in with the email address listed for you on the application.</p>
      <p style="font-size:.78rem;color:var(--muted)">Need help? <a href="tel:7077063137" style="color:#1d4ed8">707-706-3137</a> &middot; <a href="mailto:support@choiceproperties.com" style="color:#1d4ed8">support@choiceproperties.com</a></p>
    </div>
  </div>`;
}

// ── Magic link session resolver ───────────────────────────────────────────────
// Magic links land here in THREE possible forms; the client must handle all
// three explicitly because supabase-js with flowType:'pkce' will ONLY
// auto-process `?code=` and ignores hash-fragment tokens.
//
//   1. Hash tokens   #access_token=...&refresh_token=...
//   2. token_hash    ?token_hash=...&type=magiclink
//   3. PKCE code     ?code=...
async function waitForMagicLinkSession(sb){
  const hashStr = (window.location.hash || '').replace(/^#/, '');
  const hashParams = new URLSearchParams(hashStr);
  const qsParams   = new URLSearchParams(window.location.search || '');

  const accessToken  = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  const tokenHash    = qsParams.get('token_hash');
  const tokenType    = qsParams.get('type');
  const codeParam    = qsParams.get('code');
  const errParam     = hashParams.get('error') || qsParams.get('error');

  if(errParam){
    const desc = hashParams.get('error_description') || qsParams.get('error_description') || errParam;
    console.warn('Magic link error:', desc);
    return {error: decodeURIComponent(desc.replace(/\+/g,' '))};
  }

  if(accessToken && refreshToken){
    try{
      const {data, error} = await sb.auth.setSession({access_token: accessToken, refresh_token: refreshToken});
      if(!error && data && data.session) return data.session;
      if(error) console.warn('setSession from hash failed:', error.message);
    }catch(e){ console.warn('setSession threw:', e); }
  }

  if(tokenHash && tokenType){
    try{
      const {data, error} = await sb.auth.verifyOtp({token_hash: tokenHash, type: tokenType});
      if(!error && data && data.session) return data.session;
      if(error) console.warn('verifyOtp failed:', error.message);
    }catch(e){ console.warn('verifyOtp threw:', e); }
  }

  if(codeParam){
    try{
      const {data:{session:existing}} = await sb.auth.getSession();
      if(existing) return existing;
    }catch(_){}

    return new Promise(resolve => {
      let sub=null;
      const t=setTimeout(()=>{ try{sub&&sub.unsubscribe();}catch(_){} resolve(null); }, 15000);
      const {data} = sb.auth.onAuthStateChange((event, session) => {
        if((event==='SIGNED_IN'||event==='TOKEN_REFRESHED'||event==='INITIAL_SESSION') && session){
          clearTimeout(t);
          try{ data.subscription.unsubscribe(); }catch(_){}
          resolve(session);
        }
      });
      sub = data.subscription;
    });
  }

  return null;
}

// ── CSP-safe image error fallback for prop-hero photo ────────────────────────
// Replaces the inline onerror="..." attribute (blocked by nonce CSP) with a
// delegated capture listener. When the hero property photo fails to load,
// swap it for the placeholder div.
document.addEventListener('error', function(e) {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.heroFallback) return;
  const placeholder = document.createElement('div');
  placeholder.className = 'prop-hero-img is-placeholder';
  placeholder.textContent = 'Your future home';
  if (img.parentNode) img.parentNode.replaceChild(placeholder, img);
}, true);

// ── CSP-safe delegated event handlers ────────────────────────────────────────
document.addEventListener('click', function(e){
  const btn = e.target.closest('[data-action]');
  if(!btn) return;
  const action = btn.dataset.action;
  switch(action){
    case 'sign-out':       return signOut();
    case 'signout-retry':  return signOutAndRetry();
    case 'withdraw':       return withdrawApplication();
    case 'download-lease':    return downloadLease();
    case 'dl-submitted-doc':  return downloadSubmittedDoc(btn.dataset.path);
    case 'lookup-app-id':     return lookupByAppId();
    case 'switch-app':     return window._switchApp && window._switchApp(btn.dataset.appId);
    case 'choose-file': {
      const target = document.getElementById(btn.dataset.target);
      if(target) target.click();
      return;
    }
  }
  // Whole-card tap on a doc checklist row (mobile grid).
  const docCard = e.target.closest('.doc-check');
  if(docCard && !e.target.closest('button,a,input')){
    const fi = docCard.querySelector('input[type=file][data-doc-type]');
    if(fi) fi.click();
  }
});
document.addEventListener('change', function(e){
  const input = e.target.closest('input[type=file][data-doc-type]');
  if(!input || !input.files || !input.files[0]) return;
  uploadDoc(input.dataset.docType, input.dataset.appId, input.id, input.dataset.statusId);
});

document.addEventListener('DOMContentLoaded',async()=>{
  initTheme();
  const ready=await waitForSB(8000);
  if(!ready){
    document.getElementById('portal-loading').innerHTML='<div class="error-card">Page failed to load. Please refresh.</div>';
    return;
  }

  const sb=getSB();
  const requestedAppId=getRequestedAppId();

  const magicResult = await waitForMagicLinkSession(sb);

  // Capture ?next= from the ORIGINAL URL before the auth-token cleanup below
  // strips all params.  login.js embeds it in the magic-link redirectTo so that
  // deposit.html / inspection.html deep-links survive the sign-in round-trip.
  // Reading it after replaceState would always yield '' because the param is
  // gone by then.
  const nextRawBeforeClean = new URLSearchParams(window.location.search).get('next') || '';

  const hadAuthInUrl = !!(window.location.hash || /[\?&](code|token_hash|error)=/.test(window.location.search));
  if(hadAuthInUrl){
    const cleanUrl = window.location.pathname + (requestedAppId ? '?app_id='+encodeURIComponent(requestedAppId) : '');
    history.replaceState(null, '', cleanUrl);
  }

  if(magicResult && magicResult.error){
    const loginUrl = new URL('/tenant/login.html', window.location.origin);
    if(requestedAppId) loginUrl.searchParams.set('app_id', requestedAppId);
    loginUrl.searchParams.set('link_error', magicResult.error);
    location.href = loginUrl.pathname + loginUrl.search;
    return;
  }

  const magicSession = (magicResult && !magicResult.error) ? magicResult : null;
  const {data:{session}} = await sb.auth.getSession();
  const activeSession = magicSession || session;

  if(!activeSession){
    const loginUrl = new URL('/tenant/login.html', window.location.origin);
    if(requestedAppId) loginUrl.searchParams.set('app_id', requestedAppId);
    // Distinguish expired sessions from fresh visits so login page can show
    // a helpful "your session expired" message instead of a blank form.
    loginUrl.searchParams.set('reason', 'session_expired');
    location.href = loginUrl.pathname + loginUrl.search;
    return;
  }

  const userEmail=(activeSession.user.email||'').toLowerCase();
  const emailEl=document.getElementById('user-email');
  if(emailEl)emailEl.textContent=userEmail;

  // Magic-link callback redirect: when the tenant tried to use deposit.html
  // or inspection.html while signed out, those pages bounce them to login
  // with ?redirect=…; login.js forwards that as ?next=… on the magic link.
  // Now that the session is live, send them to that page instead of the
  // portal home. Same-origin tenant paths only — anything else is ignored.
  // NOTE: use nextRawBeforeClean captured above — by this point the URL has
  // already been cleaned by history.replaceState and ?next= is gone.
  const nextRaw = nextRawBeforeClean || new URLSearchParams(window.location.search).get('next') || '';
  const nextOk = typeof nextRaw === 'string'
    && nextRaw.startsWith('/')
    && !nextRaw.startsWith('//')
    && !nextRaw.includes('\\')
    && /^\/tenant\//.test(nextRaw);
  if (nextOk) {
    location.replace(nextRaw);
    return;
  }

  const loading=document.getElementById('portal-loading');
  const content=document.getElementById('portal-content');
  const errorEl=document.getElementById('portal-error');

  if(requestedAppId){
    const {data:claimResult,error:claimErr}=await sb.rpc('claim_application',{p_app_id:requestedAppId,p_email:userEmail});
    if(claimErr||claimResult?.success===false){
      await redirectWrongAccount(requestedAppId);
      return;
    }
  }

  const {data:rpcResult,error:rpcErr}=await sb.rpc('get_my_applications');
  let myApps=[];
  if(!rpcErr&&rpcResult?.success&&Array.isArray(rpcResult.applications)){
    myApps=rpcResult.applications;
  }

  if(!myApps.length){
    await autoClaimApplications(sb,userEmail);
    const {data:r2}=await sb.rpc('get_my_applications');
    if(r2?.success&&Array.isArray(r2.applications)) myApps=r2.applications;
  }

  loading.style.display='none';
  content.style.display='block';

  if(!myApps.length){
    content.innerHTML=`<div class="no-app">
      <div style="font-size:2.4rem;margin-bottom:14px">&#128269;</div>
      <h3 style="margin-bottom:10px">No application found</h3>
      <p style="color:var(--muted);font-size:.87rem;line-height:1.7;margin-bottom:6px">
        We searched for an application linked to<br>
        <strong style="color:var(--text);font-size:.92rem">${esc(userEmail)}</strong>
      </p>
      <p style="color:var(--muted);font-size:.82rem;line-height:1.65;margin-bottom:18px">
        Make sure you are signed in with the exact email address you used on your rental application — even a slight difference (like a period or extra letter) will prevent a match.
      </p>

      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:18px;text-align:left">
        <div style="font-size:.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Look up by Application ID</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="text" id="manual-app-id" placeholder="e.g. CP-20260420-ABC123" autocomplete="off" autocapitalize="characters"
            style="flex:1;min-width:160px;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:.85rem;font-family:inherit;-webkit-appearance:none">
          <button type="button" data-action="lookup-app-id" style="padding:9px 16px;border-radius:8px;background:#1d4ed8;border:none;color:#fff;font-size:.83rem;font-weight:700;cursor:pointer;font-family:inherit;touch-action:manipulation;white-space:nowrap">Look Up</button>
        </div>
        <div id="appid-msg" style="margin-top:8px;font-size:.78rem;color:var(--muted);display:none"></div>
      </div>

      <button type="button" data-action="sign-out" style="width:100%;background:#dbeafe;border:1px solid #bfdbfe;color:#1d4ed8;padding:11px 18px;border-radius:9px;cursor:pointer;font-family:inherit;font-size:.86rem;font-weight:600;touch-action:manipulation;min-height:44px">&#8592; Sign in with a different email</button>

      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border);text-align:left">
        <p style="font-size:.79rem;color:var(--muted);margin-bottom:6px"><strong style="color:var(--text)">Co-applicant?</strong> Sign in with the email address listed for you on the application, not the primary applicant's email.</p>
        <p style="font-size:.79rem;color:var(--muted)">Still need help? <a href="tel:7077063137" style="color:#1d4ed8;font-weight:600">Call or text 707-706-3137</a> &middot; <a href="mailto:support@choiceproperties.com" style="color:#1d4ed8">Email us</a></p>
      </div>
    </div>`;
    return;
  }

  const summary=requestedAppId
    ? (myApps.find(a=>(a.app_id||a.id)===requestedAppId)||myApps[0])
    : myApps[0];

  if(!summary){
    content.innerHTML=renderWrongAccount(userEmail,requestedAppId,'This application is not linked to the current signed-in email.');
    return;
  }

  window._portalAppId=summary.app_id||summary.id;
  sessionStorage.setItem('pendingPortalAppId',window._portalAppId);

  async function loadAndRenderApp(appId){
    window._portalAppId=appId;
    sessionStorage.setItem('pendingPortalAppId',appId);

    // Phase 2 — single-shot tenant_portal_state RPC. Returns app +
    // property + cover_photo + documents in one round-trip. If the
    // function is missing on this Supabase project (e.g., migration
    // not applied yet) or the call fails for any reason, we fall back
    // to the legacy three-call path below — same as before this change.
    let fullApp = null;
    let prefetchedProperty = null;
    let prefetchedCoverPhoto = null;
    let prefetchedDocs = null;
    try {
      const { data:rpc, error:rpcErr } = await sb.rpc('tenant_portal_state', { p_app_id: appId });
      if(!rpcErr && rpc && rpc.success){
        fullApp = rpc.app;
        prefetchedProperty = rpc.property;
        prefetchedCoverPhoto = rpc.cover_photo;
        prefetchedDocs = rpc.documents;
      } else if(rpc && rpc.success === false){
        // Server returned a structured error: not authenticated / not found / access denied.
        errorEl.style.display = 'block';
        errorEl.innerHTML = '<div class="error-card">' + esc(rpc.error || 'Could not load application') + '. Please refresh or <a href="tel:7077063137" style="color:#1d4ed8">call us</a>.</div>';
        return;
      }
      // Anything else (404 from missing function, network error) → fall through to legacy path.
    } catch(_) { /* legacy fallback */ }

    if(!fullApp){
      const {data:legacyApp,error:fetchErr}=await sb.from('applications')
        .select(
          'id,app_id,created_at,updated_at,status,payment_status,payment_date,application_fee,'+
          'payment_amount_recorded,payment_method_recorded,payment_notes,'+
          'holding_fee_requested,holding_fee_amount,holding_fee_due_date,holding_fee_paid,holding_fee_paid_at,'+
          'payment_confirmed_at,payment_amount_collected,payment_method_confirmed,'+
          'first_name,last_name,email,property_address,property_id,'+
          'lease_status,lease_sent_date,lease_signed_date,lease_start_date,lease_end_date,'+
          'monthly_rent,security_deposit,move_in_costs,'+
          'move_in_status,move_in_date_actual,move_in_notes,'+
          'tenant_sign_token,has_co_applicant,admin_notes,desired_lease_term'
        )
        .eq('app_id',appId)
        .maybeSingle();

      if(fetchErr||!legacyApp){
        errorEl.style.display='block';
        errorEl.innerHTML='<div class="error-card">Could not load application details. Please refresh or <a href="tel:7077063137" style="color:#1d4ed8">call us</a>.</div>';
        if(fetchErr)console.error('Portal fetch error:',fetchErr.message);
        return;
      }
      fullApp = legacyApp;
    }

    let switcherHtml='';
    if(myApps.length>1){
      const statusColor={pending:'#a16207',approved:'#15803d',denied:'#b91c1c',waitlisted:'#7e22ce',withdrawn:'#64748b'};
      const pills=myApps.map(a=>{
        const aId=a.app_id||a.id;
        const isActive=aId===appId;
        const col=statusColor[a.status]||'#64748b';
        const addr=esc((a.property_address||'Application').split(',')[0]);
        return `<button type="button" class="app-switch-pill" data-active="${isActive?'1':'0'}" data-action="switch-app" data-app-id="${esc(aId)}">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${col};margin-right:5px;vertical-align:middle"></span>
          ${addr}
        </button>`;
      }).join('');
      switcherHtml=`<div class="app-switch" role="tablist" aria-label="Switch application">${pills}</div>`;
    }

    content.innerHTML=switcherHtml+renderPortal(fullApp);
    // Live countdowns + the document checklist. When the portal-pulse RPC
    // returned docs, populateDocChecklist skips the storage.list round-trip.
    startCountdownTickers(content);
    populateDocChecklist(appId, prefetchedDocs);
    loadSubmittedDocs(appId);
    setupDropzone();

    // Hydrate the property hero. When the portal-pulse RPC returned the
    // property + cover photo, render synchronously (zero extra round-trips).
    // Otherwise, fall back to fetchProperty() — same behaviour as before.
    if(prefetchedProperty){
      const prop = Object.assign({}, prefetchedProperty, { _photo: prefetchedCoverPhoto?.url || null });
      const slot = document.getElementById('prop-hero-slot');
      if(slot) slot.innerHTML = renderPropertyHero(fullApp, prop);
    } else if(fullApp.property_id){
      fetchProperty(fullApp.property_id).then(prop => {
        const slot = document.getElementById('prop-hero-slot');
        if(slot) slot.innerHTML = renderPropertyHero(fullApp, prop);
      }).catch(() => {
        const slot = document.getElementById('prop-hero-slot');
        if(slot) slot.innerHTML = renderPropertyHero(fullApp, null);
      });
    } else {
      const slot = document.getElementById('prop-hero-slot');
      if(slot) slot.innerHTML = renderPropertyHero(fullApp, null);
    }

    // Live updates: subscribe to this application's row.
    // Toast fires immediately on the first event so the tenant gets instant
    // feedback. Re-renders are debounced so that a burst of rapid admin edits
    // (e.g. setting rent + dates + status in quick succession) collapses into
    // a single RPC call instead of stacking concurrent fetches that could race.
    let _realtimeRenderTimer = null;
    setupRealtime(sb, fullApp.id, (payload) => {
      const next = payload && payload.new;
      if(!next) return;
      // Detect what changed (high-signal fields only) for a meaningful toast.
      const prev = window._portalAppSnapshot || {};
      let toastMsg = null, toastKind = 'info';
      if(prev.status !== next.status){
        if(next.status === 'approved'){ toastMsg = 'Your application was approved'; toastKind = 'success'; }
        else if(next.status === 'denied'){ toastMsg = 'A decision was made on your application'; toastKind = 'warn'; }
        else if(next.status === 'waitlisted'){ toastMsg = 'You were added to the waitlist'; toastKind = 'info'; }
      }
      else if(prev.lease_status !== next.lease_status && (next.lease_status === 'sent' || next.lease_status === 'co_signed')){
        toastMsg = next.lease_status === 'sent' ? 'Your lease is ready to sign' : 'Your lease is fully executed';
        toastKind = 'success';
      }
      else if((prev.payment_status !== next.payment_status) && next.payment_status === 'paid'){
        toastMsg = 'Application fee received'; toastKind = 'success';
      }
      else if(prev.move_in_status !== next.move_in_status && next.move_in_status === 'confirmed'){
        toastMsg = 'Move-in confirmed'; toastKind = 'success';
      }
      else if(prev.admin_notes !== next.admin_notes && next.admin_notes){
        toastMsg = 'A new note from our team'; toastKind = 'info';
      }
      if(toastMsg) showToast(toastMsg, toastKind);
      // Re-render with the new row (this also rebuilds the activity feed).
      // Debounced: waits 600 ms after the last event before fetching, so a
      // rapid burst of admin saves collapses into one round-trip.
      clearTimeout(_realtimeRenderTimer);
      _realtimeRenderTimer = setTimeout(() => loadAndRenderApp(appId), 600);
    });
    window._portalAppSnapshot = fullApp;
  }

  window._switchApp=async function(appId){
    content.innerHTML='<div class="skeleton-set"><div class="skel skel-hero"></div><div class="skel-card"><div class="skel skel-line title"></div><div class="skel skel-line long"></div><div class="skel skel-line med"></div></div></div>';
    await loadAndRenderApp(appId);
  };

  await loadAndRenderApp(window._portalAppId);
});
