/**
 * cleanup-expired-drafts
 *
 * Deletes draft_applications rows that are older than 7 days from
 * their original created_at. Drafts are ephemeral resume helpers —
 * once the window expires the data should not persist.
 *
 * Triggered by:
 *   • pg_cron (nightly at 03:00 UTC) via net.http_post — set up in
 *     migration 20260514000002_pg_cron_cleanup_drafts.sql
 *   • Manual admin POST for on-demand cleanup or testing
 *   • dry_run: true body param — returns count without deleting
 *
 * Auth: CRON_SECRET header OR valid admin JWT.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';
const DRAFT_TTL_DAYS = 7;

async function verifyAuth(req: Request): Promise<{ ok: boolean; actor: string; error?: string }> {
  const cronHeader = req.headers.get('x-cron-secret') || '';
  if (CRON_SECRET && cronHeader && cronHeader === CRON_SECRET) {
    return { ok: true, actor: 'cron' };
  }
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, actor: '', error: 'Missing authorization' };
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false, actor: '', error: 'Invalid token' };
  const { data: role } = await supabase
    .from('admin_roles').select('id').eq('user_id', user.id).single();
  if (!role) return { ok: false, actor: '', error: 'Not an admin' };
  return { ok: true, actor: user.email || 'admin' };
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonErr(405, 'Method not allowed');
  }

  const auth = await verifyAuth(req);
  if (!auth.ok) return jsonErr(401, auth.error || 'Unauthorized');

  let dryRun = false;
  if (req.method === 'POST') {
    try { const b = await req.json(); dryRun = !!b?.dry_run; } catch { /* no body fine */ }
  }

  const cutoff = new Date(Date.now() - DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Count candidates first (used for both dry_run and actual run)
  const { count, error: countErr } = await supabase
    .from('draft_applications')
    .select('*', { count: 'exact', head: true })
    .lt('created_at', cutoff);

  if (countErr) {
    console.error('cleanup-expired-drafts count error:', JSON.stringify(countErr));
    return jsonErr(500, 'Count query failed: ' + countErr.message);
  }

  const candidateCount = count ?? 0;

  if (dryRun) {
    console.log(`[dry_run] cleanup-expired-drafts: ${candidateCount} drafts would be deleted (cutoff: ${cutoff})`);
    return jsonOk({
      dry_run: true,
      cutoff,
      ttl_days: DRAFT_TTL_DAYS,
      would_delete: candidateCount,
    });
  }

  if (candidateCount === 0) {
    console.log(`cleanup-expired-drafts: nothing to delete (cutoff: ${cutoff})`);
    return jsonOk({ deleted: 0, cutoff, ttl_days: DRAFT_TTL_DAYS });
  }

  const { error: deleteErr } = await supabase
    .from('draft_applications')
    .delete()
    .lt('created_at', cutoff);

  if (deleteErr) {
    console.error('cleanup-expired-drafts delete error:', JSON.stringify(deleteErr));
    return jsonErr(500, 'Delete failed: ' + deleteErr.message);
  }

  console.log(
    `cleanup-expired-drafts: deleted ${candidateCount} expired drafts` +
    ` (cutoff: ${cutoff}, actor: ${auth.actor})`
  );

  return jsonOk({
    deleted: candidateCount,
    cutoff,
    ttl_days: DRAFT_TTL_DAYS,
    actor: auth.actor,
  });
});
