// Choice Properties — Admin: state-law.js
//
// Phase 02 — read-only state law reference table.
// Pulls every row from the public anon SELECT policy on
// state_lease_law (no PII; values are statute-derived public
// information). No mutations possible from this page.

import { supabase as sb } from '/js/cp-api.js';

const $ = (s, r = document) => r.querySelector(s);
const tbody = $('#sl-tbody');
const meta  = $('#sl-meta');

let ROWS = [];
let SORT = { key: 'state_code', dir: 'asc' };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function fmtMonths(v) { return v == null ? '—' : Number(v).toFixed(v % 1 === 0 ? 0 : 1); }
function fmtNum(v)    { return v == null ? '—' : String(v); }
function fmtPct(v)    { return v == null ? '—' : Number(v).toFixed(v % 1 === 0 ? 0 : 2) + '%'; }
function fmtMoney(v)  { return v == null ? '' : '$' + Number(v).toFixed(2); }

function fmtLateFee(row) {
  const pct  = row.late_fee_cap_pct_of_rent;
  const flat = row.late_fee_cap_flat;
  if (pct == null && flat == null) return '<span class="sl-pill">no cap</span>';
  const parts = [];
  if (pct  != null) parts.push(fmtPct(pct));
  if (flat != null) parts.push(fmtMoney(flat));
  let txt = parts.join(' / ');
  if (row.late_fee_no_fee_until_days != null) txt += ` · none until d${row.late_fee_no_fee_until_days}`;
  if (row.late_fee_grace_period_days != null) txt += ` · grace ${row.late_fee_grace_period_days}d`;
  return escapeHtml(txt);
}

function fmtDepHandling(row) {
  const bits = [];
  if (row.security_deposit_separate_account)  bits.push('<span class="sl-pill">separate acct</span>');
  if (row.security_deposit_interest_required) bits.push('<span class="sl-pill">interest</span>');
  if (row.security_deposit_bank_disclosure)   bits.push('<span class="sl-pill">bank disclose</span>');
  return bits.length ? bits.join(' ') : '<span class="sl-pill" style="opacity:.5">—</span>';
}

function fmtHoldover(rule) {
  const map = {
    double_rent:     '<span class="sl-pill bad">double rent</span>',
    month_to_month:  '<span class="sl-pill ok">m-to-m</span>',
    court_discretion:'<span class="sl-pill">court</span>',
  };
  return map[rule] ?? escapeHtml(rule || '—');
}

function fmtJustCause(req) {
  return req
    ? '<span class="sl-pill warn">required</span>'
    : '<span class="sl-pill" style="opacity:.6">no</span>';
}

function fmtRentInc(row) {
  let s = fmtNum(row.rent_increase_notice_days) + 'd';
  if (row.rent_increase_large_notice_days != null) {
    s += ` · ${row.rent_increase_large_notice_days}d if >${fmtPct(row.rent_increase_large_threshold_pct)}`;
  }
  return escapeHtml(s);
}

function fmtTranslations(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '<span class="sl-pill" style="opacity:.5">—</span>';
  return arr.map(l => `<span class="sl-pill lang">${escapeHtml(l.toUpperCase())}</span>`).join('');
}

function fmtSources(row) {
  const links = [];
  if (row.statute_security_deposit) links.push(`<a class="sl-link" target="_blank" rel="noopener" href="${escapeHtml(row.statute_security_deposit)}">deposit</a>`);
  if (row.statute_late_fees)        links.push(`<a class="sl-link" target="_blank" rel="noopener" href="${escapeHtml(row.statute_late_fees)}">late fees</a>`);
  if (row.statute_entry)            links.push(`<a class="sl-link" target="_blank" rel="noopener" href="${escapeHtml(row.statute_entry)}">entry</a>`);
  if (row.statute_eviction)         links.push(`<a class="sl-link" target="_blank" rel="noopener" href="${escapeHtml(row.statute_eviction)}">eviction</a>`);
  if (row.statute_holdover)         links.push(`<a class="sl-link" target="_blank" rel="noopener" href="${escapeHtml(row.statute_holdover)}">holdover</a>`);
  return links.join(' · ') || '<span class="sl-pill" style="opacity:.5">—</span>';
}

function renderStats(rows) {
  const total           = rows.length;
  const noCap           = rows.filter(r => r.security_deposit_max_months == null).length;
  const justCause       = rows.filter(r => r.just_cause_required).length;
  const requiresEscrow  = rows.filter(r => r.security_deposit_separate_account).length;
  const requiresInterest = rows.filter(r => r.security_deposit_interest_required).length;
  const html = [
    `<div class="sl-stat"><strong>${total}</strong>jurisdictions</div>`,
    `<div class="sl-stat"><strong>${noCap}</strong>no statutory deposit cap</div>`,
    `<div class="sl-stat"><strong>${justCause}</strong>just-cause required</div>`,
    `<div class="sl-stat"><strong>${requiresEscrow}</strong>separate account req'd</div>`,
    `<div class="sl-stat"><strong>${requiresInterest}</strong>deposit interest req'd</div>`,
  ].join('');
  const stats = $('#sl-stats');
  stats.innerHTML = html;
  stats.hidden = false;
}

function applyFilters(rows) {
  const q   = $('#sl-search').value.trim().toLowerCase();
  const cap = $('#sl-filter-cap').value;
  const jc  = $('#sl-filter-jc').value;
  return rows.filter(r => {
    if (q) {
      const hay = (r.state_code + ' ' + r.state_name).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (cap === 'none') {
      if (r.security_deposit_max_months != null) return false;
    } else if (cap) {
      const max = Number(cap);
      if (r.security_deposit_max_months == null || r.security_deposit_max_months > max) return false;
    }
    if (jc === 'true'  && !r.just_cause_required) return false;
    if (jc === 'false' &&  r.just_cause_required) return false;
    return true;
  });
}

function applySort(rows) {
  const k = SORT.key;
  const dir = SORT.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[k], bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return  1;        // nulls last regardless of dir
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function rowHtml(r) {
  const noteToggle = r.notes
    ? `<details class="sl-notes"><summary>notes</summary><p>${escapeHtml(r.notes)}</p></details>`
    : '';
  return `<tr>
    <td>
      <span class="sl-state">${escapeHtml(r.state_code)}</span>
      <div class="sl-meta" style="font-size:.7rem">${escapeHtml(r.state_name)}</div>
      ${noteToggle}
    </td>
    <td class="sl-num">${fmtMonths(r.security_deposit_max_months)}</td>
    <td class="sl-num">${fmtNum(r.security_deposit_return_days)}</td>
    <td>${fmtDepHandling(r)}</td>
    <td>${fmtLateFee(r)}</td>
    <td class="sl-num">${fmtNum(r.entry_notice_hours)}</td>
    <td class="sl-num">${fmtNum(r.eviction_notice_nonpayment_days)}</td>
    <td>${fmtHoldover(r.holdover_rule)}</td>
    <td>${fmtJustCause(r.just_cause_required)}</td>
    <td>${fmtRentInc(r)}</td>
    <td>${fmtTranslations(r.required_translation_languages)}</td>
    <td>${fmtSources(r)}</td>
  </tr>`;
}

function render() {
  const filtered = applyFilters(ROWS);
  const sorted   = applySort(filtered);
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="sl-empty">No jurisdictions match the current filters.</td></tr>';
  } else {
    tbody.innerHTML = sorted.map(rowHtml).join('');
  }
  meta.textContent = `Showing ${sorted.length} of ${ROWS.length} jurisdictions.`;
  document.querySelectorAll('.sl-table thead th[data-sort]').forEach(th => {
    const ind = th.querySelector('.sort-ind');
    if (!ind) return;
    if (th.dataset.sort === SORT.key) ind.textContent = SORT.dir === 'asc' ? '▲' : '▼';
    else ind.textContent = '';
  });
}

async function load() {
  try {
    const { data, error } = await sb.from('state_lease_law').select('*').order('state_code');
    if (error) throw error;
    ROWS = data || [];
    renderStats(ROWS);
    render();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="12" class="sl-empty" style="color:#f08491">Failed to load state law data: ${escapeHtml(e?.message || String(e))}</td></tr>`;
    meta.textContent = '';
    console.error('[state-law]', e);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Wait for AdminShell (loaded by cp-shell.js, a classic defer script).
  // Then verify admin role before showing any data.
  try {
    await new Promise((res, rej) => {
      const start = Date.now();
      (function tick() {
        if (window.AdminShell) return res();
        if (Date.now() - start > 8000) return rej(new Error('Admin tools failed to load.'));
        setTimeout(tick, 80);
      })();
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="12" class="sl-empty" style="color:#f08491">${escapeHtml(e.message)}</td></tr>`;
    if (meta) meta.textContent = '';
    return;
  }
  const ok = await AdminShell.requireAdmin();
  if (!ok) return;

  $('#sl-search').addEventListener('input', render);
  $('#sl-filter-cap').addEventListener('change', render);
  $('#sl-filter-jc').addEventListener('change', render);
  document.querySelectorAll('.sl-table thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (SORT.key === k) SORT.dir = SORT.dir === 'asc' ? 'desc' : 'asc';
      else { SORT.key = k; SORT.dir = 'asc'; }
      render();
    });
  });
  load();
});
