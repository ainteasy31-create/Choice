// ============================================================
// Choice Properties — Orion Extension Config
// ============================================================
// Holds the import secret for the receive-pipeline-import edge function.
// The secret is also embedded as a fallback in content.js for
// backward compatibility with already-installed extensions.
// ============================================================
window.CP_CONFIG = {
  IMPORT_SECRET: 'cp_import_7Kx3m9P2w5',
  EDGE_URL: 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import',
  VERSION: '3.1.1'
};
