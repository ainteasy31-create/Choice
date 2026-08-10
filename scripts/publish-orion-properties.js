// Publishes the 4 Zillow properties added via Orion, then transfers photos to ImageKit.
// Uses the pipeline_publish RPC + import-pipeline-photos edge function.
const PROJECT_REF = 'tlfmwetmhthpyrytrcfo';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || (process.argv.find(a => a.startsWith('--token=')) || '').split('=')[1];
if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN env var or --token= arg is required');
  process.exit(1);
}

const SUPABASE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || (process.argv.find(a => a.startsWith('--service-key=')) || '').split('=')[1];
if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY env var or --service-key= arg is required');
  process.exit(1);
}

async function rpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return { ok: res.ok, data: JSON.parse(text) }; } catch { return { ok: res.ok, data: text }; }
}

async function main() {
  // Get the 4 Zillow properties added today
  const qUrl = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
  const query = `
    SELECT id, title, address, city, monthly_rent, data_quality_score,
           original_image_urls, source_listing_id, choice_property_id, status
    FROM pipeline.pipeline_properties
    WHERE source = 'zillow'
      AND scraped_at >= '2026-08-10'
      AND status IN ('scraped', 'edited', 'published')
    ORDER BY scraped_at DESC;
  `;
  const res = await fetch(qUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const props = await res.json();
  console.log(`Found ${props.length} Zillow properties to process\n`);

  for (const p of props) {
    let imgCount = 0;
    try { imgCount = JSON.parse(p.original_image_urls || '[]').length; } catch {}
    console.log(`--- ${p.address}, ${p.city} ---`);
    console.log(`  Images: ${imgCount} | Quality: ${p.data_quality_score}/100 | Rent: $${p.monthly_rent}`);

    if (imgCount < 6) {
      console.log(`  SKIP: only ${imgCount} image(s) — below 6-photo minimum. Cannot publish.`);
      console.log('');
      continue;
    }

    // If already published, use the existing choice_property_id
    let propId = p.choice_property_id;
    if (propId) {
      console.log(`  Already published — using existing property_id = ${propId}`);
    } else {
      // Publish via RPC
      const pub = await rpc('pipeline_publish', { p_id: p.id, p_landlord_id: null });
      if (!pub.ok || pub.data?.ok === false) {
        console.log(`  PUBLISH FAILED: ${pub.data?.error || pub.data || 'unknown'}`);
        console.log('');
        continue;
      }
      propId = pub.data.choice_property_id;
      console.log(`  Published! property_id = ${propId}`);
    }

    // Transfer photos to ImageKit via edge function
    const edgeRes = await fetch(`${SUPABASE_URL}/functions/v1/import-pipeline-photos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'x-import-secret': 'cp_import_7Kx3m9P2w5',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pipeline_id: p.id, property_id: propId }),
    });
    const edgeText = await edgeRes.text();
    let edgeData = {};
    try { edgeData = JSON.parse(edgeText); } catch {}
    console.log(`  Photo transfer: HTTP ${edgeRes.status} — ${edgeData.transferred || 0} transferred, ${edgeData.skipped || 0} skipped`);
    console.log('');
  }
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });