// Inspects the pipeline_properties to assess quality, images, and status
const PROJECT_REF = 'tlfmwetmhthpyrytrcfo';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || (process.argv.find(a => a.startsWith('--token=')) || '').split('=')[1];
if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN env var or --token= arg is required');
  process.exit(1);
}

(async () => {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

  // Get all pipeline properties with key fields
  const query = `
    SELECT
      id, status, title, address, city, state, zip,
      source, source_listing_id,
      bedrooms, bathrooms, square_footage, monthly_rent,
      data_quality_score, missing_fields,
      original_image_urls, photo_import_status,
      scraped_at, updated_at
    FROM pipeline.pipeline_properties
    WHERE status NOT IN ('archived')
    ORDER BY updated_at DESC
    LIMIT 30;
  `;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  console.log('HTTP', res.status);
  if (!res.ok) {
    console.error('Query failed:', text);
    process.exit(1);
  }
  const rows = JSON.parse(text);
  console.log('\n=== PIPELINE PROPERTIES ===');
  console.log(`Total: ${rows.length}`);
  rows.forEach((r, i) => {
    let imgCount = 0;
    try { imgCount = JSON.parse(r.original_image_urls || '[]').length; } catch {}
    console.log(`\n${i+1}. [${r.status}] ${r.title || '(no title)'}`);
    console.log(`   ${r.address || ''}, ${r.city || ''} ${r.state || ''} ${r.zip || ''}`);
    console.log(`   Source: ${r.source} | ID: ${r.source_listing_id}`);
    console.log(`   Rent: $${r.monthly_rent || '?'} | Beds: ${r.bedrooms || '?'} | Baths: ${r.bathrooms || '?'} | Sqft: ${r.square_footage || '?'}`);
    console.log(`   Quality: ${r.data_quality_score}/100`);
    console.log(`   Images: ${imgCount} source URLs (import status: ${r.photo_import_status || 'none'})`);
    console.log(`   Scraped: ${r.scraped_at} | Updated: ${r.updated_at}`);
  });
})();