/**
 * property-shared.js
 * Shared utilities for all admin property pages.
 * Loaded via <script defer> before page-specific scripts.
 * Exposes window.CPPropertyShared.
 */
(function () {
  'use strict';

  const STATUS_VALUES = ['active', 'rented', 'inactive', 'maintenance', 'draft', 'paused', 'archived'];

  const PILL_MAP = {
    active: 'pill-success', rented: 'pill-info', inactive: 'pill-muted',
    maintenance: 'pill-warning', draft: 'pill-muted', paused: 'pill-warning', archived: 'pill-muted',
    pending: 'pill-warning', approved: 'pill-success', declined: 'pill-muted',
    submitted: 'pill-info', reviewing: 'pill-info', waitlisted: 'pill-warning',
  };

  function pill(s) {
    return '<span class="pill ' + (PILL_MAP[s] || 'pill-muted') + '">' + (s || 'unknown') + '</span>';
  }

  function fmtMoney(v) {
    if (v == null || v === '') return '—';
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v)); }
    catch (e) { return '$' + v; }
  }

  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return d; }
  }

  function daysAgo(d) {
    if (!d) return null;
    const ms = Date.now() - new Date(d).getTime();
    const days = Math.floor(ms / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    return days + ' days ago';
  }

  function waitReady(ms) {
    return new Promise(function (res, rej) {
      const start = Date.now();
      (function tick() {
        if (window.AdminShell && window.CP && CP.sb && CP.Auth) return res();
        if (Date.now() - start > ms) return rej(new Error('Admin tools failed to load.'));
        setTimeout(tick, 80);
      })();
    });
  }

  async function logAdminAction(action, targetType, targetId, metadata) {
    try {
      const { data: ud } = await CP.sb().auth.getUser();
      await CP.sb().from('admin_actions').insert([{
        user_id: ud && ud.user ? ud.user.id : null,
        action: action,
        target_type: targetType,
        target_id: String(targetId),
        metadata: metadata || {},
      }]);
    } catch (e) { /* non-blocking */ }
  }

  function exportCSV(rows, filename) {
    if (!rows || !rows.length) return;
    const headers = [
      'ID', 'Title', 'Address', 'City', 'State', 'Zip', 'Status', 'Type',
      'Bedrooms', 'Bathrooms', 'Rent', 'Security Deposit', 'SqFt',
      'Landlord', 'Available', 'Featured', 'Created', 'Updated'
    ];
    const lines = [
      headers.join(','),
      ...rows.map(function (p) {
        return [
          p.id,
          p.title || '',
          p.address || '',
          p.city || '',
          p.state || '',
          p.zip || '',
          p.status || '',
          p.property_type || '',
          p.bedrooms != null ? p.bedrooms : '',
          p.bathrooms != null ? p.bathrooms : '',
          p.monthly_rent != null ? p.monthly_rent : '',
          p.security_deposit != null ? p.security_deposit : '',
          p.square_footage != null ? p.square_footage : '',
          p.landlords ? (p.landlords.business_name || p.landlords.contact_name || '') : '',
          p.available_date ? p.available_date.slice(0, 10) : '',
          p.featured ? 'Yes' : 'No',
          p.created_at ? p.created_at.slice(0, 10) : '',
          p.updated_at ? p.updated_at.slice(0, 10) : '',
        ].map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
      })
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'properties.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  window.CPPropertyShared = {
    STATUS_VALUES: STATUS_VALUES,
    PILL_MAP: PILL_MAP,
    pill: pill,
    fmtMoney: fmtMoney,
    fmtDate: fmtDate,
    daysAgo: daysAgo,
    waitReady: waitReady,
    logAdminAction: logAdminAction,
    exportCSV: exportCSV,
  };
})();
