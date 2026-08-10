// Deploys the pipeline_folders migration directly to the remote Supabase DB
// via the Management API query endpoint. Avoids the migration-history
// mismatch that blocks `supabase db push`.
const fs = require('fs');
const path = require('path');

const PROJECT_REF = 'tlfmwetmhthpyrytrcfo'; // Choice project
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN env var is required');
  process.exit(1);
}
const MIGRATION_FILE = path.join(__dirname, '..', 'supabase', 'migrations', '20260810000001_pipeline_folders.sql');

(async () => {
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  const text = await res.text();
  console.log('HTTP', res.status);
  console.log(text.slice(0, 2000));

  if (!res.ok) {
    console.error('Migration failed!');
    process.exit(1);
  }
  console.log('Migration applied successfully.');
})();