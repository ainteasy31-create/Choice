// Verifies the 3 published Zillow properties are active with photos
const PROJECT_REF = 'tlfmwetmhthpyrytrcfo';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || (process.argv.find(a => a.startsWith('--token=')) || '').split('=')[1];
if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN env var or --token= arg is required');
  process.exit(1);
}

(async () => {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

  const query = `
    SELECT p.id, p.title, p.address, p.city, p.state, p.status, p.monthly_rent,
           (SELECT COUNT(*) FROM property_photos ph WHERE ph.property_id = p.id) AS photo_count
    FROM properties p
    WHERE p.id IN (
      'ece129ac-09f3-4ee9-a315-a53b04ff4373',
      '10bd30a8-8342-4854-8298-3949e548f900',
      'b9d49a93-37fb-46d0-97e0-d4940015ebbf'
    );
  `;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  console.log('HTTP', res.status);
  if (!res.ok) { console.error('Query failed:', text); process.exit(1); }
  const rows = JSON.parse(text);
  console.log('\n=== PUBLISHED PROPERTIES STATUS ===');
  rows.forEach(r => {
    console.log(`\n${r.address}, ${r.city} ${r.state}`);
    console.log(`  Status: ${r.status} | Rent: $${r.monthly_rent}`);
    console.log(`  Photos on ImageKit: ${r.photo_count}`);
    console.log(`  Live URL: https://choice-properties-site.pages.dev/property.html?id=${r.id}`);
  });
})();