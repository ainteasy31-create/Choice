// Verifies the pipeline_folders migration was applied by checking
// that the folder RPC functions exist in the remote database.
const PROJECT_REF = 'tlfmwetmhthpyrytrcfo';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN env var is required');
  process.exit(1);
}

(async () => {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

  const query = `
    SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'pipeline_folder%'
    ORDER BY p.proname;
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
  console.log(text);

  if (!res.ok) {
    console.error('Verification query failed!');
    process.exit(1);
  }

  const funcs = JSON.parse(text);
  const expected = [
    'pipeline_folder_add_property',
    'pipeline_folder_create',
    'pipeline_folder_delete',
    'pipeline_folder_list',
    'pipeline_folder_properties',
    'pipeline_folder_publish',
    'pipeline_folder_remove_property',
    'pipeline_folder_rename',
    'pipeline_folder_stats',
  ];

  const missing = expected.filter(f => !funcs.some(r => r.proname === f));
  if (missing.length) {
    console.error('MISSING functions:', missing.join(', '));
    process.exit(1);
  }
  console.log('All 9 folder RPC functions verified present ✓');
})();