/* =====================================================================
   Choice Properties — cp-chrome.js  (Phase 2 rename of admin-chrome.js)
   Injects the shared portal chrome (sprite + sidebar + appbar + tabbar)
   into admin, landlord, and tenant pages so each page's HTML stays
   focused on its own content.

   Usage:
     <body data-portal="admin|landlord|tenant"
           data-page-title="Leases"
           data-page-sub="Lifecycle">
       <div class="app">
         <main class="app-content"> … </main>
       </div>

   Optional body data-* hooks:
     data-portal     "admin" (default) | "landlord" | "tenant"
     data-back="1"   show a back button in the appbar
     data-refresh="0"  hide the refresh button
     data-live="0"   hide the live-pulse dot

   Auth pages (login/register/lease-sign) should NOT load this script —
   they use the .auth-shell layout from cp-design.css instead.

   Exposes: window.CPChrome
   ===================================================================== */
(function (window, document) {
  'use strict';

  const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
  <defs>
    <symbol id="i-home"     viewBox="0 0 24 24"><path d="M3 12l9-9 9 9M5 10v10h14V10"/></symbol>
    <symbol id="i-apps"     viewBox="0 0 24 24"><path d="M14 3h7v7h-7zM3 3h7v7H3zM14 14h7v7h-7zM3 14h7v7H3z"/></symbol>
    <symbol id="i-leases"   viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></symbol>
    <symbol id="i-property" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2h-3v-7H8v7H5a2 2 0 0 1-2-2z"/></symbol>
    <symbol id="i-more"     viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/></symbol>
    <symbol id="i-bell"     viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></symbol>
    <symbol id="i-arrow"    viewBox="0 0 24 24"><path d="M5 12h14M13 5l7 7-7 7"/></symbol>
    <symbol id="i-back"     viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></symbol>
    <symbol id="i-search"   viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></symbol>
    <symbol id="i-clock"    viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></symbol>
    <symbol id="i-check"    viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></symbol>
    <symbol id="i-alert"    viewBox="0 0 24 24"><path d="M10.3 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0M12 9v4M12 17h.01"/></symbol>
    <symbol id="i-mail"     viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2"/><path d="M22 6l-10 7L2 6"/></symbol>
    <symbol id="i-door"     viewBox="0 0 24 24"><path d="M3 21V3h12v18M15 21h6M15 12h.01M9 21V3"/></symbol>
    <symbol id="i-list"     viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></symbol>
    <symbol id="i-user"     viewBox="0 0 24 24"><circle cx="12" cy="7" r="4"/><path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/></symbol>
    <symbol id="i-image"    viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></symbol>
    <symbol id="i-history"  viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2"/></symbol>
    <symbol id="i-message"  viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></symbol>
    <symbol id="i-out"      viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></symbol>
    <symbol id="i-refresh"  viewBox="0 0 24 24"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></symbol>
    <symbol id="i-plus"     viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="i-trash"    viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></symbol>
    <symbol id="i-edit"     viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></symbol>
    <symbol id="i-eye"      viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8"/><circle cx="12" cy="12" r="3"/></symbol>
    <symbol id="i-x"        viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></symbol>
    <symbol id="i-card"     viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></symbol>
    <symbol id="i-cog"      viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></symbol>
    <symbol id="i-sun"      viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></symbol>
    <symbol id="i-moon"     viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></symbol>
    <symbol id="i-spark"    viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></symbol>
    <symbol id="i-listings" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></symbol>
    <symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></symbol>
    <symbol id="i-filter"   viewBox="0 0 24 24"><path d="M22 3H2l8 9.46V19l4 2v-8.54z"/></symbol>
    <symbol id="i-kbd"      viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M6 16h12"/></symbol>
  </defs>
</svg>`;

  // ─────────────────────────────────────────────────────────────────────
  // Per-portal navigation. All hrefs are relative — they resolve against
  // the current page's directory (/admin/, /landlord/, or /tenant/).
  // ─────────────────────────────────────────────────────────────────────
  // ⚠️  Adding a new admin/landlord/tenant page? You MUST register it in BOTH
  //     `nav` (desktop sidebar) AND `more` (mobile overflow drawer) below,
  //     otherwise the page will exist but have no link to reach it.
  const PORTAL = {
    admin: {
      brand: { logo: 'CP', name: 'Choice Properties', sub: 'Admin' },
      nav: [
        { sect: 'Overview',       items: [
          { href: 'dashboard.html',       icon: 'i-home',     label: 'Dashboard' }
        ]},
        { sect: 'Applications',   items: [
          { href: 'applications.html',    icon: 'i-apps',     label: 'Applications' },
          { href: 'leases.html',          icon: 'i-leases',   label: 'Leases' },
          { href: 'move-ins.html',        icon: 'i-door',     label: 'Move-ins' }
        ]},
        { sect: 'Properties',     items: [
          { href: '/listings.html',       icon: 'i-property', label: 'Properties' },
          { href: 'pipeline.html',        icon: 'i-spark',    label: 'Pipeline' },
          { href: 'landlords.html',       icon: 'i-user',     label: 'Landlords' }
        ]},
        { sect: 'Communications', items: [
          { href: 'messages.html',        icon: 'i-message',  label: 'Messages' },
          { href: 'email-logs.html',      icon: 'i-mail',     label: 'Email Logs' }
        ]},
        { sect: 'Operations',     items: [
          { href: 'inspections.html',     icon: 'i-check',    label: 'Inspections' }
        ]},
        { sect: 'Admin',          items: [
          { href: 'audit-log.html',             icon: 'i-history',  label: 'Audit Log' },
          { href: 'watermark-review.html',      icon: 'i-image',    label: 'Watermark Review' },
          { href: 'deposit-accounting.html',    icon: 'i-card',     label: 'Deposit Accounting' },
          { href: 'state-law.html',             icon: 'i-list',     label: 'State Law Reference' },
          { href: 'location-notifications.html',icon: 'i-listings', label: 'New Locations' }
        ]}
      ],
      tabs: [
        { href: 'dashboard.html',    icon: 'i-home',     label: 'Home' },
        { href: 'applications.html', icon: 'i-apps',     label: 'Apps' },
        { href: 'leases.html',       icon: 'i-leases',   label: 'Leases' },
        { href: '/listings.html',    icon: 'i-property', label: 'Properties' }
      ],
      more: [
        { href: 'move-ins.html',          icon: 'i-door',    label: 'Move-ins' },
        { href: 'inspections.html',       icon: 'i-check',   label: 'Inspections' },
        { href: 'pipeline.html',          icon: 'i-spark',   label: 'Pipeline' },
        { href: 'landlords.html',         icon: 'i-user',    label: 'Landlords' },
        { href: 'messages.html',          icon: 'i-message', label: 'Messages' },
        { href: 'email-logs.html',        icon: 'i-mail',    label: 'Email logs' },
        { href: 'audit-log.html',         icon: 'i-history', label: 'Audit log' },
        { href: 'watermark-review.html',      icon: 'i-image',    label: 'Watermark review' },
        { href: 'deposit-accounting.html',    icon: 'i-card',     label: 'Deposit accounting' },
        { href: 'state-law.html',             icon: 'i-list',     label: 'State law reference' },
        { href: 'location-notifications.html',icon: 'i-listings', label: 'New Locations' }
      ]
    },

    landlord: {
      brand: { logo: 'CP', name: 'Choice Properties', sub: 'Landlord' },
      nav: [
        { sect: 'Overview',   items: [
          { href: 'dashboard.html',    icon: 'i-home',    label: 'Dashboard' }
        ]},
        { sect: 'Properties', items: [
          { href: 'edit-listing.html', icon: 'i-list',    label: 'My Listings' },
          { href: 'new-listing.html',  icon: 'i-plus',    label: 'New Listing' }
        ]},
        { sect: 'Pipeline',   items: [
          { href: 'inquiries.html',         icon: 'i-message', label: 'Inquiries' },
          { href: 'applications.html',      icon: 'i-apps',    label: 'Applications' },
          { href: 'inspection-review.html', icon: 'i-check',   label: 'Inspection Review' }
        ]},
        { sect: 'Account',    items: [
          { href: 'profile.html',      icon: 'i-user',    label: 'Profile' },
          { href: 'settings.html',     icon: 'i-cog',     label: 'Settings' }
        ]}
      ],
      tabs: [
        { href: 'dashboard.html',    icon: 'i-home',    label: 'Home' },
        { href: 'edit-listing.html', icon: 'i-list',    label: 'Listings' },
        { href: 'inquiries.html',    icon: 'i-message', label: 'Inquiries' },
        { href: 'applications.html', icon: 'i-apps',    label: 'Apps' }
      ],
      more: [
        { href: 'new-listing.html',         icon: 'i-plus',  label: 'New Listing' },
        { href: 'inspection-review.html',   icon: 'i-check', label: 'Inspection Review' },
        { href: 'profile.html',             icon: 'i-user',  label: 'Profile' },
        { href: 'settings.html',            icon: 'i-cog',   label: 'Settings' }
      ]
    },

    tenant: {
      brand: { logo: 'CP', name: 'Choice Properties', sub: 'Tenant' },
      nav: [
        { sect: 'Portal', items: [
          { href: 'portal.html',  icon: 'i-home', label: 'Home' },
          { href: 'deposit.html', icon: 'i-mail', label: 'Move-out & Deposit' }
        ]}
      ],
      tabs: [
        { href: 'portal.html',  icon: 'i-home', label: 'Home' },
        { href: 'deposit.html', icon: 'i-mail', label: 'Deposit' }
      ],
      more: []
    }
  };

  function detectPortal() {
    const v = (document.body && document.body.dataset.portal) || '';
    if (PORTAL[v]) return v;
    // Fallback: infer from URL path.
    const path = location.pathname;
    if (path.indexOf('/landlord/') !== -1) return 'landlord';
    if (path.indexOf('/tenant/')   !== -1) return 'tenant';
    return 'admin';
  }

  function buildSidebar(cfg) {
    const sections = cfg.nav.map(s =>
      `<div class="nav-section">${s.sect}</div>` +
      s.items.map(i =>
        `<a class="nav-item" href="${i.href}" data-nav="${i.href}">` +
        `<svg class="i"><use href="#${i.icon}"/></svg> ${i.label}</a>`
      ).join('')
    ).join('');
    return `
<aside class="sidebar">
  <div class="sidebar-brand">
    <div class="logo">${cfg.brand.logo}</div>
    <div>
      <div class="name">${cfg.brand.name}</div>
      <div class="sub">${cfg.brand.sub}</div>
    </div>
  </div>
  ${sections}
  <div class="sidebar-footer">
    <div class="muted text-xs" id="admin-name" style="margin-bottom:8px">Loading…</div>
    <button class="btn btn-ghost btn-block btn-sm" data-action="sign-out"><svg class="i i-sm"><use href="#i-out"/></svg> Sign Out</button>
  </div>
</aside>`;
  }

  function buildAppbar(title, sub, opts) {
    opts = opts || {};
    const back = opts.back
      ? `<button class="btn-icon" aria-label="Back" data-action="go-back"><svg class="i"><use href="#i-back"/></svg></button>`
      : '';
    const refresh = opts.refresh === false ? ''
      : `<button class="btn-icon" aria-label="Refresh" data-action="refresh"><svg class="i"><use href="#i-refresh"/></svg></button>`;
    const live = opts.live === false ? ''
      : `<span class="live-dot" title="Live updates"></span>`;
    return `
<header class="appbar">
  ${back}
  <div style="flex:1;min-width:0">
    <div class="appbar-title" id="page-title">${title}</div>
    <div class="appbar-sub" id="page-sub">${sub}</div>
  </div>
  <div class="row-flex gap-2">${live}${refresh}</div>
</header>`;
  }

  function buildTabbar(cfg) {
    const tabs = cfg.tabs.map(t =>
      `<a class="tab" href="${t.href}" data-nav="${t.href}">` +
      `<svg class="i"><use href="#${t.icon}"/></svg>${t.label}</a>`
    ).join('');
    const more = cfg.more && cfg.more.length
      ? `<a class="tab" href="#" data-action="open-more"><svg class="i"><use href="#i-more"/></svg>More</a>`
      : '';
    return `
<nav class="tabbar" style="${more ? '' : 'grid-template-columns:repeat(' + cfg.tabs.length + ',1fr)'}">
  ${tabs}${more}
</nav>`;
  }

  function moreSheetBody(cfg) {
    const rows = cfg.more.map(i =>
      `<a class="list-row" href="${i.href}"><div class="list-row-inner">` +
      `<svg class="i"><use href="#${i.icon}"/></svg>` +
      `<div class="row-body"><div class="row-title">${i.label}</div></div>` +
      `</div></a>`
    ).join('');
    return `<div class="list">${rows}<div style="height:12px"></div>` +
      `<button class="btn btn-ghost btn-block" data-action="sign-out">` +
      `<svg class="i i-sm"><use href="#i-out"/></svg> Sign out</button></div>`;
  }

  function mount() {
    const body = document.body;
    if (!body || body.dataset.cpChrome === 'mounted') return;

    const portal = detectPortal();
    const cfg    = PORTAL[portal];

    const title = body.dataset.pageTitle || document.title.split(/[·—-]/)[0].trim() || cfg.brand.sub;
    const sub   = body.dataset.pageSub   || '';
    const opts  = {
      back:    body.dataset.back === '1',
      refresh: body.dataset.refresh !== '0',
      live:    body.dataset.live !== '0'
    };

    // Sprite first so subsequent <use> works during mount.
    body.insertAdjacentHTML('afterbegin', SPRITE);

    // Find/wrap the .app container so chrome lives outside .app-content.
    let appEl = body.querySelector('.app');
    if (!appEl) {
      const main = document.createElement('div');
      main.className = 'app';
      const content = document.createElement('main');
      content.className = 'app-content';
      const sprite = body.querySelector('svg[aria-hidden="true"]');
      while (body.firstChild) {
        const node = body.firstChild;
        if (node === sprite) { body.removeChild(node); continue; }
        content.appendChild(node);
      }
      main.appendChild(content);
      body.appendChild(main);
      if (sprite) body.insertBefore(sprite, body.firstChild);
      appEl = main;
    }

    appEl.insertAdjacentHTML('afterbegin', buildSidebar(cfg) + buildAppbar(title, sub, opts));
    appEl.insertAdjacentHTML('beforeend', buildTabbar(cfg));

    body.dataset.cpChrome    = 'mounted';

    function wire(attempt) {
      attempt = attempt || 0;
      const S = window.CPShell || window.AdminShell;
      if (!S) {
        if (attempt < 50) setTimeout(() => wire(attempt + 1), 50);
        return;
      }
      S.on('refresh', () => location.reload());
      S.on('open-more', (target, e) => {
        e.preventDefault();
        if (!cfg.more || !cfg.more.length) return;
        S.openSheet({ title: 'More', body: moreSheetBody(cfg) });
      });
    }
    setTimeout(wire, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.CPChrome    = { mount: mount, PORTAL: PORTAL };
})(window, document);
