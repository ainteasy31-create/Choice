import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/send-email.ts';
import { signingEmailHtml } from '../_shared/email.ts';
import { buildLeasePDF } from '../_shared/pdf.ts';
import { getSiteUrl } from '../_shared/config.ts';
import {
  ensureSnapshotForApp,
  resolveLeaseTemplateDetailed,
  finalizeAndStorePdf,
} from '../_shared/lease-render.ts';
import {
  selectRequiredAddenda,
  persistAttachedAddenda,
} from '../_shared/lease-addenda.ts';
import { computeFirstMonthProration, type ProrationMethod } from '../_shared/proration.ts';
import { normalizeUtilityMatrix } from '../_shared/utility-matrix.ts';
import { ensureLeaseForApp } from '../_shared/lease-mirror.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function logEmail(appId: string, type: string, recipient: string, status: string, provider = 'gas', errorMsg: string | null = null) {
  try { await supabase.from('email_logs').insert({ app_id: appId, type, recipient, status, provider, error_msg: errorMsg }); } catch (_) {}
}

async function verifyAdmin(req: Request): Promise<{ ok: boolean; userId?: string; userEmail?: string; error?: string }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, error: 'Missing authorization header' };
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false, error: 'Invalid or expired token' };
  const { data: role } = await supabase.from('admin_roles').select('id').eq('user_id', user.id).single();
  if (!role) return { ok: false, error: 'Not an admin' };
  return { ok: true, userId: user.id, userEmail: user.email };
}

/**
 * Phase 04 - look up the property's year_built and property_type so
 * the addenda selector can decide whether federal lead-paint applies
 * (year_built<1978) and so JSONB applies_when predicates can match.
 * Best-effort: missing or unmatched property is non-fatal; the
 * selector's conservative default (assume disclosure may apply when
 * year is unknown) keeps us legally safe.
 */
async function fetchPropertyMetaForAddenda(app: Record<string, unknown>): Promise<{ year_built: number | null; property_type: string | null }> {
  const addr = (app.property_address as string | undefined)?.trim();
  if (!addr) return { year_built: null, property_type: null };
  try {
    const { data } = await supabase
      .from('properties')
      .select('year_built, property_type')
      .ilike('address', addr.split(',')[0].trim())
      .maybeSingle();
    if (data) {
      return {
        year_built: (data as { year_built: number | null }).year_built ?? null,
        property_type: (data as { property_type: string | null }).property_type ?? null,
      };
    }
  } catch (_) { /* non-fatal */ }
  return { year_built: null, property_type: null };
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const auth = await verifyAdmin(req);
  if (!auth.ok) return jsonErr(401, auth.error!);

  let body: { app_id: string; lease_data?: Record<string, unknown>; dry_run?: boolean; template_id?: string };
  try { body = await req.json(); } catch { return jsonErr(400, 'Invalid JSON body'); }

  const { app_id, lease_data = {}, dry_run = false, template_id } = body;
  if (!app_id) return jsonErr(400, 'Missing app_id');

  // 1. Fetch application
  const { data: app, error: appErr } = await supabase
    .from('applications').select('*').eq('app_id', app_id).single();
  if (appErr || !app) return jsonErr(404, 'Application not found: ' + (appErr?.message || ''));
  if (!dry_run && app.status !== 'approved') {
    return jsonErr(400, `Cannot generate lease: application status is "${app.status}". Application must be approved first.`);
  }

  // 2. Resolve the lease state code (Phase 03 - no silent default).
  const explicitState = (lease_data.lease_state_code as string | undefined)?.trim();
  const appState      = (app.lease_state_code as string | undefined)?.trim()
                     || (app.property_state_code as string | undefined)?.trim();
  const leaseStateCode = (explicitState || appState || '').toUpperCase();
  if (!leaseStateCode) {
    return jsonErr(400,
      'Cannot generate lease: lease state is not set on this application. ' +
      'Set lease_state_code on the application (or pass lease_data.lease_state_code in this request) before generating a lease.');
  }
  if (!/^[A-Z]{2}$/.test(leaseStateCode)) {
    return jsonErr(400, `Invalid lease_state_code "${leaseStateCode}" - must be a 2-letter US state code.`);
  }

  // 3. Merge admin-supplied lease fields (Phase 07 added itemized + utilities)
  const pickNum = (v: unknown, fallback: unknown) => {
    if (v === null) return null;
    if (v === undefined) return fallback ?? null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : (fallback ?? null);
  };

  const leaseFields: Record<string, unknown> = {
    lease_start_date:       lease_data.lease_start_date       ?? app.lease_start_date,
    lease_end_date:         lease_data.lease_end_date         ?? app.lease_end_date,
    monthly_rent:           lease_data.monthly_rent           ?? app.monthly_rent,
    security_deposit:       lease_data.security_deposit       ?? app.security_deposit,
    move_in_costs:          lease_data.move_in_costs          ?? app.move_in_costs,
    lease_notes:            lease_data.lease_notes            ?? app.lease_notes,
    lease_landlord_name:    lease_data.lease_landlord_name    ?? app.lease_landlord_name    ?? 'Choice Properties',
    lease_landlord_address: lease_data.lease_landlord_address ?? app.lease_landlord_address ?? '2265 Livernois Suite 500, Troy MI 48083',
    lease_late_fee_flat:    lease_data.lease_late_fee_flat    ?? app.lease_late_fee_flat,
    lease_late_fee_daily:   lease_data.lease_late_fee_daily   ?? app.lease_late_fee_daily,
    lease_state_code:       leaseStateCode,
    lease_pets_policy:      lease_data.lease_pets_policy      ?? app.lease_pets_policy,
    lease_smoking_policy:   lease_data.lease_smoking_policy   ?? app.lease_smoking_policy,

    // Phase 07 — itemized financial components
    first_month_rent:        pickNum(lease_data.first_month_rent,        app.first_month_rent),
    last_month_rent:         pickNum(lease_data.last_month_rent,         app.last_month_rent),
    pet_deposit:             pickNum(lease_data.pet_deposit,             app.pet_deposit),
    pet_rent:                pickNum(lease_data.pet_rent,                app.pet_rent),
    admin_fee:               pickNum(lease_data.admin_fee,               app.admin_fee),
    key_deposit:             pickNum(lease_data.key_deposit,             app.key_deposit),
    parking_fee:             pickNum(lease_data.parking_fee,             app.parking_fee),
    cleaning_fee:            pickNum(lease_data.cleaning_fee,            app.cleaning_fee),
    cleaning_fee_refundable: typeof lease_data.cleaning_fee_refundable === 'boolean'
                               ? lease_data.cleaning_fee_refundable
                               : (app.cleaning_fee_refundable ?? null),
    rent_due_day_of_month:   (() => {
                               const v = pickNum(lease_data.rent_due_day_of_month, app.rent_due_day_of_month ?? 1);
                               const n = Number(v);
                               return Math.max(1, Math.min(28, Number.isFinite(n) ? Math.round(n) : 1));
                             })(),
    rent_proration_method:   (lease_data.rent_proration_method ?? app.rent_proration_method ?? 'daily') as ProrationMethod,

    // Phase 07 — utility responsibility matrix (always normalized to canonical shape)
    utility_responsibilities: normalizeUtilityMatrix(
      lease_data.utility_responsibilities ?? app.utility_responsibilities ?? {}
    ),

    updated_at:             new Date().toISOString(),
  };

  // Phase 07 — auto-compute prorated first month when not explicitly set
  // and the move-in date lands mid-cycle.
  const monthlyRent = Number(leaseFields.monthly_rent) || 0;
  const startDate   = leaseFields.lease_start_date as string | undefined;
  let prorationDetail: ReturnType<typeof computeFirstMonthProration> | null = null;
  if (startDate && monthlyRent > 0) {
    try {
      prorationDetail = computeFirstMonthProration({
        moveInDate:  String(startDate).slice(0, 10),
        monthlyRent,
        dueDay:      leaseFields.rent_due_day_of_month as number,
        method:      leaseFields.rent_proration_method as ProrationMethod,
      });
      if (lease_data.prorated_first_month != null) {
        leaseFields.prorated_first_month = pickNum(lease_data.prorated_first_month, null);
      } else if (app.prorated_first_month != null) {
        leaseFields.prorated_first_month = app.prorated_first_month;
      } else {
        leaseFields.prorated_first_month = prorationDetail.proratedAmount;
      }
    } catch (_) {
      // bad date — leave proration unset, lease still generates
      leaseFields.prorated_first_month = lease_data.prorated_first_month ?? app.prorated_first_month ?? null;
    }
  }

  // Phase 07 — state-cap validation (defense-in-depth: also enforced in DB).
  try {
    const { data: vRes, error: vErr } = await supabase.rpc('validate_lease_financials', {
      p_state_code:          leaseStateCode,
      p_monthly_rent:        monthlyRent,
      p_security_deposit:    leaseFields.security_deposit       ?? null,
      p_pet_deposit:         leaseFields.pet_deposit            ?? null,
      p_last_month_rent:     leaseFields.last_month_rent        ?? null,
      p_cleaning_fee:        leaseFields.cleaning_fee           ?? null,
      p_cleaning_refundable: leaseFields.cleaning_fee_refundable ?? null,
    });
    if (!vErr && typeof vRes === 'string' && vRes.trim()) {
      return jsonErr(400, vRes);
    }
  } catch (_) { /* validator missing → skip rather than block */ }

  const mergedApp = { ...app, ...leaseFields };

  // ----- Phase 04: pick required addenda BEFORE we commit anything -----
  // We do this early so a missing-addendum error short-circuits before
  // we mutate the application or write a versioned PDF row.
  const propMeta = await fetchPropertyMetaForAddenda(mergedApp);
  const addendaForApp = {
    ...mergedApp,
    property_year_built: propMeta.year_built,
    property_type:       propMeta.property_type,
  };

  const addenda = await selectRequiredAddenda(supabase, addendaForApp);
  if (addenda.missing_required.length > 0) {
    return jsonErr(400,
      'Cannot generate lease: state ' + leaseStateCode +
      ' requires addendum(a) "' + addenda.missing_required.join('", "') +
      '" which are not in the addenda library. Seed the missing addendum(a) before generating.'
    );
  }

  // ----- DRY RUN: preview only -----
  if (dry_run) {
    const tmplResult = await resolveLeaseTemplateDetailed(supabase, mergedApp);
    if (!tmplResult.template) {
      const err = tmplResult.error;
      if (err?.kind === 'no_state') return jsonErr(400, err.message);
      if (err?.kind === 'no_template_for_state') return jsonErr(404, err.message);
      return jsonErr(500, 'No lease template could be resolved for this application.');
    }
    const tmpl = tmplResult.template;

    let pdfBytes: Uint8Array;
    try {
      pdfBytes = await buildLeasePDF(mergedApp, tmpl.template_body, {
        addenda:             addenda.attached,
        addendaAssetBaseUrl: getSiteUrl(),
      });
    } catch (e) { return jsonErr(500, 'PDF generation failed: ' + (e as Error).message); }

    const previewPath = `${app_id}/preview_${Date.now()}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('lease-pdfs')
      .upload(previewPath, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) return jsonErr(500, 'Preview upload failed: ' + uploadErr.message);

    const { data: signedData, error: signErr } = await supabase.storage
      .from('lease-pdfs').createSignedUrl(previewPath, 3600);
    if (signErr || !signedData?.signedUrl) return jsonErr(500, 'Could not generate preview URL');

    try {
      await supabase.from('admin_actions').insert({
        action:      'lease_preview_generated',
        target_type: 'application',
        target_id:   app_id,
        metadata:    {
          app_id,
          actor:               auth.userEmail || 'admin',
          template_source:     tmpl.source,
          template_state_code: tmpl.state_code,
          legal_review_status: tmpl.legal_review_status,
          addenda_count:       addenda.attached.length,
          addenda_slugs:       addenda.attached.map(a => a.slug),
        },
      });
    } catch (_) {}

    return jsonOk({
      success:               true,
      dry_run:               true,
      preview_url:           signedData.signedUrl,
      app_id,
      template_source:       tmpl.source,
      template_version:      tmpl.version_number,
      template_state_code:   tmpl.state_code,
      legal_review_status:   tmpl.legal_review_status,
      addenda_attached:      addenda.attached.map(a => ({ slug: a.slug, title: a.title, jurisdiction: a.jurisdiction })),
      addenda_filtered_out:  addenda.filtered_out,
    });
  }

  // ----- PRODUCTION -----
  // 4. Persist admin-edited lease fields
  await supabase.from('applications').update(leaseFields).eq('app_id', app_id);

  // 5. Pre-flight template existence check (no half-state)
  {
    const pre = await resolveLeaseTemplateDetailed(supabase, { ...mergedApp, lease_template_version_id: null });
    if (!pre.template) {
      const err = pre.error;
      if (err?.kind === 'no_state') return jsonErr(400, err.message);
      if (err?.kind === 'no_template_for_state') return jsonErr(404, err.message);
      return jsonErr(500, 'No lease template could be resolved for this application.');
    }
  }

  // 6. Snapshot the active template
  const snapshot = await ensureSnapshotForApp(supabase, app_id, template_id);
  if (!snapshot.ok) return jsonErr(500, 'Template snapshot failed: ' + (snapshot.error || 'unknown'));

  // 7. Reload merged app and resolve template
  const { data: appWithSnap } = await supabase
    .from('applications').select('*').eq('app_id', app_id).single();
  const finalResult = await resolveLeaseTemplateDetailed(supabase, appWithSnap || mergedApp);
  if (!finalResult.template) return jsonErr(500, 'Snapshot succeeded but template could not be resolved: ' + (finalResult.error?.message || ''));
  const tmpl = finalResult.template;

  // 8. Persist addenda attachment rows BEFORE rendering the PDF so
  //    the lease_addenda_attached snapshots are available for sign-lease
  //    to record per-addendum acknowledgments later.
  // application_pk is a BIGINT legacy column; applications.id is now UUID.
  // Pass null — app_id (text) is the canonical reference key.
  const attachRes = await persistAttachedAddenda(
    supabase,
    app_id,
    null,
    addenda.attached,
  );
  if (!attachRes.ok) return jsonErr(500, 'Addenda attachment failed: ' + attachRes.error);

  // 9-11. Build + hash + upload + version-row + integrity-row +
  //       application pointer in one shared helper. NO certificate
  //       page on pre_sign (no signers yet).
  const fin = await finalizeAndStorePdf({
    supabase,
    app_id,
    app:                 appWithSnap || mergedApp,
    templateText:        tmpl.template_body,
    templateVersionId:   tmpl.version_id,
    templateVersion:     tmpl.version_number,
    event:               'pre_sign',
    createdBy:           auth.userEmail || null,
    addenda:             addenda.attached,
    addendaAssetBaseUrl: getSiteUrl(),
    updateAppPointer:    true,
    // certificate intentionally omitted: pre_sign has no signers
  });
  if (!fin.ok) return jsonErr(500, fin.error || 'PDF write failed');
  const versionNumber = fin.version_number!;
  const storagePath   = fin.storage_path!;

  // 12. Generate signing tokens
  const { error: tokenErr } = await supabase.rpc('generate_lease_tokens', { p_app_id: app_id });
  if (tokenErr) return jsonErr(500, 'Token generation failed: ' + tokenErr.message);

  // 12b. Phase 10 -- create or refresh the leases row that mirrors
  // this application's lease snapshot. Sets applications.current_lease_id
  // and stamps lease_id on the freshly-minted signing tokens + child
  // rows (pdf versions, addenda attachments) for downstream resolvers.
  const { data: appAfterTokens } = await supabase
    .from('applications').select('*').eq('app_id', app_id).single();
  let leaseId: string | null = null;
  if (appAfterTokens) {
    const ensured = await ensureLeaseForApp(supabase, appAfterTokens, auth.userEmail || null);
    if (ensured.ok) leaseId = ensured.lease_id;
    else console.error('ensureLeaseForApp failed (non-fatal):', ensured.error);
  }

  // 13. Reload + send signing email
  const { data: updatedApp } = await supabase
    .from('applications').select('*').eq('app_id', app_id).single();

  if (updatedApp?.email && updatedApp?.tenant_sign_token) {
    const signingUrl = `${getSiteUrl()}/lease-sign.html?token=${updatedApp.tenant_sign_token}`;
    try {
      const sigResult = await sendEmail({
        to:      updatedApp.email,
        subject: `\u{1F4DC} Your Lease is Ready to Sign - Choice Properties (Ref: ${app_id})`,
        html:    signingEmailHtml(updatedApp.first_name || 'Applicant', updatedApp.property_address || '', signingUrl, app_id),
      });
      await logEmail(app_id, 'lease_signing_invite', updatedApp.email, sigResult.ok ? 'sent' : 'failed', sigResult.provider, sigResult.ok ? null : (sigResult.error || 'failed'));
    } catch (e) { console.error('Signing email failed (non-fatal):', (e as Error).message); }
  }

  try {
    await supabase.from('admin_actions').insert({
      action:      'generate_lease',
      target_type: 'application',
      target_id:   app_id,
      metadata:    {
        app_id,
        actor:                auth.userEmail || 'admin',
        template_version_id:  snapshot.version_id,
        template_version_no:  snapshot.version_number,
        template_state_code:  tmpl.state_code,
        legal_review_status:  tmpl.legal_review_status,
        pdf_version_number:   versionNumber,
        addenda_count:        addenda.attached.length,
        addenda_slugs:        addenda.attached.map(a => a.slug),
      },
    });
  } catch (_) {}

  return jsonOk({
    success:               true,
    app_id,
    // Phase 10: surface the new lease_id so admin UIs can navigate
    // straight to the lease detail/history view without re-resolving.
    lease_id:              leaseId,
    storage_path:          storagePath,
    pdf_version_number:    versionNumber,
    template_version_id:   snapshot.version_id,
    template_version_no:   snapshot.version_number,
    template_state_code:   tmpl.state_code,
    legal_review_status:   tmpl.legal_review_status,
    lease_status:          'sent',
    addenda_attached:      addenda.attached.map(a => ({ slug: a.slug, title: a.title, jurisdiction: a.jurisdiction })),
  });
});
  