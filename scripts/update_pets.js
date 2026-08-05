#!/usr/bin/env node
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/update_pets.js [--dry-run]
// This script finds active properties with pets_allowed != true, sanitizes descriptions
// removing negative pet language, and sets pets_allowed = true. It writes a CSV report.

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required.');
  process.exit(1);
}

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

function sanitizeDescription(d) {
  if (!d) return d;
  let s = String(d);
  // Common negative pet phrases to remove
  const negatives = [
    /\bno pets?\b/gi,
    /\bpets? not allowed\b/gi,
    /\bno animals?\b/gi,
    /\bsorry,? no pets?\b/gi,
    /\bno dogs?\b/gi,
    /\bno cats?\b/gi,
    /\bno pets allowed\b/gi,
    /\bnot pet friendly\b/gi,
    /\bpet-free\b/gi,
  ];
  negatives.forEach(r => { s = s.replace(r, ''); });

  // Collapse extra whitespace and punctuation left behind
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!\?])/g, '$1').trim();

  // Ensure we don't accidentally remove useful context — if resulting string is empty, keep original
  if (!s) return d;

  // Ensure explicit positive statement about pets exists
  if (!/\bpet(s)? allowed\b/i.test(s) && !/\bpet[- ]friendly\b/i.test(s)) {
    s = s + '\n\nPets allowed. Please contact the landlord for any pet deposits, breed, or size restrictions.';
  }

  return s;
}

async function fetchRows() {
  // Fetch active properties where pets_allowed is null or false
  const url = `${SUPABASE_URL.replace(/\/+$/,'')}/rest/v1/properties?status=eq.active&select=id,title,description,pets_allowed,pet_details,pet_deposit,pet_types_allowed`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return await res.json();
}

async function patchRow(id, body) {
  const url = `${SUPABASE_URL.replace(/\/+$/,'')}/rest/v1/properties?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`PATCH ${id} failed: ${res.status} ${res.statusText}`);
  return await res.json();
}

(async () => {
  try {
    console.log(DRY_RUN ? 'Running in dry-run mode' : 'Running in apply mode');
    const rows = await fetchRows();
    console.log(`Found ${rows.length} active properties (will filter by pets_allowed != true).`);

    const toUpdate = rows.filter(r => !(r.pets_allowed === true));
    console.log(`Candidates for update: ${toUpdate.length}`);

    const out = [];
    for (const r of toUpdate) {
      const oldDesc = r.description || '';
      const newDesc = sanitizeDescription(oldDesc);
      const body = { pets_allowed: true };
      if (newDesc !== oldDesc) body.description = newDesc;
      // If there are no pet_details, optionally set a short summary in pet_details
      if (!r.pet_details || String(r.pet_details).trim().length === 0) {
        body.pet_details = 'Pets allowed. Contact landlord for pet deposits or restrictions.';
      }

      out.push({ id: r.id, title: r.title, oldDesc: oldDesc.replace(/\r?\n/g,' '), newDesc: newDesc.replace(/\r?\n/g,' ') });

      if (!DRY_RUN) {
        const res = await patchRow(r.id, body);
        console.log(`Updated ${r.id}`);
      } else {
        console.log(`(dry) Would update ${r.id}`);
      }
    }

    const csvLines = ['id,title,old_description,new_description'];
    for (const o of out) {
      const line = `${JSON.stringify(o.id)},${JSON.stringify(o.title || '')},${JSON.stringify(o.oldDesc || '')},${JSON.stringify(o.newDesc || '')}`;
      csvLines.push(line);
    }

    const reportPath = path.join(process.cwd(), 'artifacts', `update-pets-report-${Date.now()}.csv`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, csvLines.join('\n'));
    console.log(`Wrote report to ${reportPath}`);

    console.log('Done. Review the report and run without --dry-run to apply changes.');
  } catch (err) {
    console.error('ERROR:', err.message || err);
    process.exit(2);
  }
})();
