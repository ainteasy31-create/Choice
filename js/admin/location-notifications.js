(function () {
  'use strict';

  const STATE_NAMES = {
    'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
    'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
    'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
    'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland',
    'MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi',
    'MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada',
    'NH':'New Hampshire','NJ':'New Jersey','NM':'New Mexico','NY':'New York',
    'NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma',
    'OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina',
    'SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah',
    'VT':'Vermont','VA':'Virginia','WA':'Washington','WV':'West Virginia',
    'WI':'Wisconsin','WY':'Wyoming','DC':'District of Columbia'
  };

  function stateToSlug(code) {
    return (STATE_NAMES[code] || code).toLowerCase().replace(/\s+/g, '-');
  }
  function cityToSlug(city) {
    return city.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }
  function fmtRelative(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins <= 1 ? 'just now' : `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  let S;
  let notifications = [];

  function locationHref(city, state) {
    return `/listings/${stateToSlug(state)}/${cityToSlug(city)}`;
  }

  function renderCard(n) {
    const stateName = STATE_NAMES[n.state] || n.state;
    const href      = locationHref(n.city, n.state);
    return `<div class="loc-notif-card new" id="card-${CSS.escape(n.city + '-' + n.state)}">
      <div>
        <div class="loc-notif-card__city">${S.esc(n.city)}</div>
        <div class="loc-notif-card__state">${S.esc(stateName)}</div>
      </div>
      <span class="loc-notif-card__badge"><i class="fas fa-map-marker-alt"></i> New location</span>
      <div class="loc-notif-card__time">Detected ${fmtRelative(n.detected_at)}</div>
      ${n.property_id ? `<div style="font-size:12px;color:#9ca3af">First property: <a href="/admin/property-detail.html?id=${encodeURIComponent(n.property_id)}" style="color:#006aff;text-decoration:none;font-weight:500">View listing</a></div>` : ''}
      <div class="loc-notif-card__actions">
        <a class="btn-view" href="${href}" target="_blank" rel="noopener">
          <i class="fas fa-external-link-alt"></i> View
        </a>
        <button class="btn-copy" data-url="https://choice-properties-site.pages.dev${href}" style="background:#f0f6ff;color:#1d4ed8;border:1.5px solid #c7dcff;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px">
          <i class="fas fa-link"></i> <span class="copy-label">Copy link</span>
        </button>
        <button class="btn-dismiss" data-city="${S.esc(n.city)}" data-state="${S.esc(n.state)}">
          Dismiss
        </button>
      </div>
    </div>`;
  }

  function renderGrid() {
    const grid      = document.getElementById('notifGrid');
    const allClear  = document.getElementById('allClearBanner');
    const hint      = document.getElementById('sectionHint');
    const countBadge = document.getElementById('notifCount');
    const dismissAll = document.getElementById('dismissAllBtn');

    if (!notifications.length) {
      grid.innerHTML = '';
      if (allClear)   allClear.style.display  = '';
      if (hint)       hint.style.display       = 'none';
      if (countBadge) countBadge.style.display = 'none';
      if (dismissAll) dismissAll.style.display = 'none';
      return;
    }

    if (allClear)   allClear.style.display  = 'none';
    if (hint)       hint.style.display       = '';
    if (countBadge) { countBadge.textContent = notifications.length; countBadge.style.display = ''; }
    if (dismissAll) dismissAll.style.display = '';

    grid.innerHTML = notifications.map(renderCard).join('');
  }

  async function dismissOne(city, state) {
    const result = await CP.Locations.dismiss(city, state);
    if (!result.ok) { S.toast('Dismiss failed: ' + (result.error || 'unknown error'), 'error'); return; }
    notifications = notifications.filter(n => !(n.city === city && n.state === state));
    renderGrid();
    S.toast(`Dismissed — ${city}, ${state}`, 'success');
  }

  async function dismissAll() {
    if (!notifications.length) return;
    const ok = await S.confirm(`Dismiss all ${notifications.length} location notifications?`);
    if (!ok) return;
    for (const n of [...notifications]) {
      await CP.Locations.dismiss(n.city, n.state).catch(() => {});
    }
    notifications = [];
    renderGrid();
    S.toast('All location notifications dismissed', 'success');
  }

  async function copyToClipboard(url, btn) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const label = btn.querySelector('.copy-label');
    if (label) label.textContent = 'Copied!';
    btn.style.color = '#15803d';
    btn.style.borderColor = '#bbf7d0';
    btn.style.background = '#f0fdf4';
    setTimeout(() => {
      if (label) label.textContent = 'Copy link';
      btn.style.color = '';
      btn.style.borderColor = '';
      btn.style.background = '';
    }, 2000);
  }

  function wireEvents() {
    document.getElementById('notifGrid').addEventListener('click', e => {
      const copyBtn = e.target.closest('.btn-copy');
      if (copyBtn) { copyToClipboard(copyBtn.dataset.url, copyBtn); return; }

      const btn = e.target.closest('.btn-dismiss');
      if (!btn) return;
      btn.disabled = true;
      dismissOne(btn.dataset.city, btn.dataset.state).catch(() => { btn.disabled = false; });
    });

    const dismissAllBtn = document.getElementById('dismissAllBtn');
    if (dismissAllBtn) dismissAllBtn.addEventListener('click', dismissAll);
  }

  async function load() {
    const ok = await S.requireAdmin();
    if (!ok) return;

    const result = await CP.Locations.getNotifications();
    if (!result.ok) {
      S.toast('Failed to load location notifications', 'error');
      return;
    }
    notifications = result.data || [];
    renderGrid();
    wireEvents();
  }

  (window.CPShell && window.CPShell.ready ? window.CPShell.ready : Promise.resolve(window.AdminShell))
    .then(shell => { S = shell || window.AdminShell; load().catch(e => { console.error(e); }); })
    .catch(e => { console.error('[location-notifications]', e); });
})();
