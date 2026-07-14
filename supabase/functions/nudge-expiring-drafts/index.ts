/**
 * nudge-expiring-drafts
 *
 * Finds saved draft applications that are between 5 and 6 days old
 * (i.e. 1–2 days before their 7-day expiry), and sends each one a
 * single re-engagement email with a resume link and an urgency notice.
 *
 * Deduplication: sets nudge_sent_at on each row so the email is sent
 * at most once per draft regardless of how many times the cron fires.
 *
 * Triggered by:
 *   • pg_cron at 09:00 UTC daily (migration 20260514000004)
 *   • Manual POST from an admin with a valid JWT (testing / on-demand)
 *   • dry_run: true body → returns count without sending or marking
 *
 * Auth: CRON_SECRET header OR valid admin JWT.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/send-email.ts';
import { getSiteUrl } from '../_shared/config.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const CRON_SECRET   = Deno.env.get('CRON_SECRET') || '';
const DRAFT_TTL_MS  = 7 * 24 * 60 * 60 * 1000;
const NUDGE_AFTER_MS = 5 * 24 * 60 * 60 * 1000; // send nudge once draft is 5 days old
const NUDGE_WINDOW_MS = 6 * 24 * 60 * 60 * 1000; // don't nudge drafts already past 6 days (cleanup handles them)

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

function buildNudgeEmail(email: string, token: string, hoursLeft: number, propertyFingerprint: string | null): string {
  const resumeUrl = `${getSiteUrl()}/apply/?resume=${encodeURIComponent(token)}`;
  const hourLabel = hoursLeft === 1 ? '1 hour' : `${hoursLeft} hours`;
  const propNote  = propertyFingerprint
    ? `<p style="margin:0 0 12px;color:#374151;">Your saved progress for the property you viewed is about to expire.</p>`
    : `<p style="margin:0 0 12px;color:#374151;">Your saved rental application progress is about to expire.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your application draft expires soon</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif;">
<div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

  <!-- Header -->
  <div style="background:#0a0f1e;padding:24px 32px;display:flex;align-items:center;gap:12px;">
    <div style="width:36px;height:36px;background:#2563eb;border-radius:8px;display:flex;align-items:center;justify-content:center;">
      <span style="color:#fff;font-size:18px;font-weight:800;">C</span>
    </div>
    <div>
      <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:-0.3px;">Choice Properties</div>
      <div style="color:#94a3b8;font-size:12px;">Rental Application</div>
    </div>
  </div>

  <!-- Urgency banner -->
  <div style="background:#fef3c7;border-bottom:3px solid #f59e0b;padding:14px 32px;display:flex;align-items:center;gap:10px;">
    <span style="font-size:20px;">⏰</span>
    <div>
      <strong style="color:#92400e;font-size:14px;">Your saved draft expires in approximately ${hourLabel}</strong>
    </div>
  </div>

  <!-- Body -->
  <div style="padding:32px;">
    <h2 style="margin:0 0 16px;color:#0a0f1e;font-size:22px;font-weight:700;letter-spacing:-0.5px;">
      Don't lose your progress
    </h2>
    ${propNote}
    <p style="margin:0 0 20px;color:#6b7280;font-size:14px;line-height:1.6;">
      You saved your application ${7 - Math.round(hoursLeft / 24)} days ago. Saved drafts are kept for 7 days — after that, your information is cleared and you would need to start over.
    </p>

    <!-- Resume CTA -->
    <div style="text-align:center;margin:28px 0;">
      <a href="${resumeUrl}"
         style="display:inline-block;background:#2563eb;color:#ffffff;font-size:15px;font-weight:700;padding:14px 36px;border-radius:8px;text-decoration:none;letter-spacing:-0.2px;">
        Continue My Application →
      </a>
      <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;">
        Your progress will be restored exactly where you left off
      </p>
    </div>

    <!-- What happens next -->
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 20px;margin-top:8px;">
      <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;">
        What happens after you submit?
      </p>
      <ol style="margin:0;padding:0 0 0 18px;color:#6b7280;font-size:13px;line-height:1.7;">
        <li>Our team reviews your application (usually within 24 hours)</li>
        <li>We contact you using your preferred payment method to arrange the application fee</li>
        <li>Once fee is received, your full review begins</li>
      </ol>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;">
    <p style="margin:0;color:#94a3b8;font-size:12px;">
      Choice Properties · 707-706-3137 ·
      <a href="${getSiteUrl()}/apply/" style="color:#6b7280;text-decoration:none;">Start a new application</a>
    </p>
    <p style="margin:8px 0 0;color:#cbd5e1;font-size:11px;">
      You're receiving this because you saved an application draft on our site.
    </p>
  </div>

</div>
</body>
</html>`;
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

  const now = Date.now();
  const nudgeFrom = new Date(now - NUDGE_WINDOW_MS).toISOString(); // older bound: 6 days ago
  const nudgeTo   = new Date(now - NUDGE_AFTER_MS).toISOString();  // newer bound: 5 days ago

  // Fetch drafts in the 5–6 day window that haven't been nudged yet
  const { data: drafts, error: fetchErr } = await supabase
    .from('draft_applications')
    .select('id, token, email, created_at, property_fingerprint')
    .lt('created_at', nudgeTo)     // older than 5 days
    .gte('created_at', nudgeFrom)  // not yet past 6 days (cleanup window)
    .is('nudge_sent_at', null)     // not already nudged
    .not('email', 'is', null);     // must have an email address

  if (fetchErr) {
    console.error('nudge-expiring-drafts fetch error:', JSON.stringify(fetchErr));
    return jsonErr(500, 'Fetch failed: ' + fetchErr.message);
  }

  const candidates = drafts ?? [];

  if (dryRun) {
    console.log(`[dry_run] nudge-expiring-drafts: ${candidates.length} drafts would be nudged`);
    return jsonOk({
      dry_run: true,
      would_nudge: candidates.length,
      nudge_window: { from: nudgeFrom, to: nudgeTo },
    });
  }

  if (candidates.length === 0) {
    console.log('nudge-expiring-drafts: no eligible drafts');
    return jsonOk({ nudged: 0 });
  }

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const draft of candidates) {
    try {
      const ageMs    = now - new Date(draft.created_at as string).getTime();
      const msLeft   = DRAFT_TTL_MS - ageMs;
      const hoursLeft = Math.max(1, Math.round(msLeft / (60 * 60 * 1000)));

      const html = buildNudgeEmail(
        draft.email as string,
        draft.token as string,
        hoursLeft,
        draft.property_fingerprint as string | null,
      );

      await sendEmail({
        to: draft.email as string,
        subject: `⏰ Your Choice Properties application expires in ~${hoursLeft}h — finish now`,
        html,
      });

      // Mark as nudged so we never send a second email for this draft
      const { error: markErr } = await supabase
        .from('draft_applications')
        .update({ nudge_sent_at: new Date().toISOString() })
        .eq('id', draft.id);

      if (markErr) {
        console.error('nudge-expiring-drafts mark error for', draft.id, JSON.stringify(markErr));
      }

      sent++;
      console.log('nudge-expiring-drafts: sent nudge (draft:', draft.id, 'hoursLeft:', hoursLeft, ')');
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${draft.id}: ${msg}`);
      console.error('nudge-expiring-drafts: failed for', draft.id, msg);
    }
  }

  return jsonOk({
    nudged: sent,
    failed,
    total_candidates: candidates.length,
    actor: auth.actor,
    ...(errors.length ? { errors } : {}),
  });
});
