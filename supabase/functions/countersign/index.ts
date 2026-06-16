/**
 * countersign — Phase 5 (updated through Phase 4)
 * Management countersignature for a tenant-signed lease.
 *
 * Phase 2 update: regenerates the PDF using the application's
 * pinned template snapshot, never the live editable template.
 *
 * Phase 4 update: writes the countersigned PDF as a NEW version
 * in lease_pdf_versions instead of overwriting the previous one,
 * preserving the full PDF history for audit.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, jsonOk, jsonErr } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/send-email.ts';
import { leaseFullyExecutedHtml, landlordLeaseExecutedHtml } from '../_shared/email.ts';
import { getTenantLoginUrl, getSiteUrl, getAdminUrl } from '../_shared/config.ts';
import { resolveLeaseTemplate, finalizeAndStorePdf } from '../_shared/lease-render.ts';
import { fetchAttachedAddenda } from '../_shared/lease-addenda.ts';
import { mirrorAppToLease } from '../_shared/lease-mirror.ts';
import { sendLandlordEmail } from '../_shared/landlord-notify.ts';

const TENANT_LOGIN_URL = getTenantLoginUrl();

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function logEmail(appId: string, type: string, recipient: string, status: string, provider = 'gas', errorMsg: string | null = null) {
  try { await supabase.from('email_logs').insert({ app_id: appId, type, recipient, status, provider, error_msg: errorMsg }); } catch (_) {}
}

async function verifyAdmin(req: Request): Promise<{ ok: boolean; userEmail?: string; error?: string }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, error: 'Missing authorization header' };
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false, error: 'Invalid or expired token' };
  const { data: role } = await supabase.from('admin_roles').select('id').eq('user_id', user.id).single();
  if (!role) return { ok: false, error: 'Not an admin' };
  return { ok: true, userEmail: user.email };
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const auth = await verifyAdmin(req);
  if (!auth.ok) return jsonErr(401, auth.error!);

  let body: { app_id: string; signer_name: string; notes?: string };
  try { body = await req.json(); } catch { return jsonErr(400, 'Invalid JSON body'); }

  const { app_id, signer_name, notes } = body;
  if (!app_id)      return jsonErr(400, 'Missing app_id');
  if (!signer_name) return jsonErr(400, 'Missing signer_name');

  const { data: app, error: appErr } = await supabase
    .from('applications').select('*').eq('app_id', app_id).single();
  if (appErr || !app) return jsonErr(404, 'Application not found');

  if (!app.tenant_signature) {
    return jsonErr(400, 'Tenant has not yet signed this lease. Management can only countersign after the tenant has signed.');
  }
  if (app.has_co_applicant && !app.co_applicant_signature) {
    return jsonErr(400, 'Co-applicant has not yet signed this lease. Both applicants must sign before management can countersign.');
  }
  if (app.management_signed || app.management_cosigned) {
    return jsonErr(400, 'This lease has already been countersigned by management.');
  }

  const now = new Date().toISOString();

  const { error: updateErr } = await supabase.from('applications').update({
    management_signed:      true,
    management_signer_name: signer_name,
    management_signed_at:   now,
    management_notes:       notes || null,
    management_cosigned:    true,
    management_cosigned_by: signer_name,
    management_cosigned_at: now,
    lease_status:           'co_signed',
    updated_at:             now,
  }).eq('app_id', app_id);
  if (updateErr) return jsonErr(500, 'Failed to record countersignature: ' + updateErr.message);

  // Phase 10 -- mirror countersignature into the lease row + transition to 'active'
  let mirroredLeaseId: string | null = null;
  {
    const { data: appAfter } = await supabase
      .from('applications').select('*').eq('app_id', app_id).single();
    if (appAfter) {
      const mir = await mirrorAppToLease(supabase, appAfter, 'countersigned');
      if (mir.ok) mirroredLeaseId = mir.lease_id;
      else console.error('mirrorAppToLease failed (non-fatal):', mir.error);
    }
  }

  // Versioned PDF re-gen using the pinned template snapshot
  // Phase 06: appends Certificate of Completion w/ all signers + QR.
  try {
    const appWithMgmt = {
      ...app,
      management_signed:      true,
      management_signer_name: signer_name,
      management_signed_at:   now,
      management_notes:       notes || null,
    };
    const tmpl = await resolveLeaseTemplate(supabase, appWithMgmt);
    if (tmpl) {
      const attachedAddenda = await fetchAttachedAddenda(supabase, app_id);
      const adminIp = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'admin-console';
      const adminUa = req.headers.get('user-agent') || '';

      // Pull co-applicant info if present so the cert lists every signer.
      let coRow: { first_name: string | null; last_name: string | null; email: string | null } | null = null;
      if (app.has_co_applicant) {
        const { data } = await supabase
          .from('co_applicants').select('first_name, last_name, email')
          .eq('app_id', app_id).maybeSingle();
        coRow = data;
      }

      const signers = [
        {
          role:       'tenant' as const,
          name:       app.tenant_signature || `${app.first_name || ''} ${app.last_name || ''}`.trim(),
          email:      app.email,
          signed_at:  app.signature_timestamp || null,
          ip:         app.lease_ip_address || null,
          user_agent: app.lease_user_agent || null,
          has_image:  !!app.tenant_signature_image,
        },
        ...(app.has_co_applicant && coRow ? [{
          role:       'co_applicant' as const,
          name:       app.co_applicant_signature || `${coRow.first_name || ''} ${coRow.last_name || ''}`.trim(),
          email:      coRow.email,
          signed_at:  app.co_applicant_signature_timestamp || null,
          ip:         app.co_applicant_lease_ip_address || null,
          user_agent: app.co_applicant_lease_user_agent || null,
          has_image:  !!app.co_applicant_signature_image,
        }] : []),
        {
          role:       'management' as const,
          name:       signer_name,
          email:      auth.userEmail || null,
          signed_at:  now,
          ip:         adminIp,
          user_agent: adminUa,
          has_image:  false,
        },
      ];

      const fin = await finalizeAndStorePdf({
        supabase,
        app_id,
        app:                 appWithMgmt,
        templateText:        tmpl.template_body,
        templateVersionId:   tmpl.version_id,
        templateVersion:     tmpl.version_number || null,
        event:               'countersigned',
        createdBy:           auth.userEmail || signer_name,
        addenda:             attachedAddenda,
        addendaAssetBaseUrl: getSiteUrl(),
        updateAppPointer:    true,
        certificate: {
          state_code:        app.lease_state_code || null,
          edge_function_tag: 'countersign@phase10',
          site_url:          getSiteUrl(),
          signers,
        },
      });
      if (!fin.ok) console.error('PDF finalize failed:', fin.error);
    }
  } catch (e) { console.error('PDF re-gen failed (non-fatal):', (e as Error).message); }

  // Audit event for management signature
  try {
    await supabase.from('sign_events').insert({
      app_id, signer_type: 'admin', signer_name, signer_email: auth.userEmail || null,
      ip_address:    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'admin-console',
      user_agent:    req.headers.get('user-agent') || '',
      lease_pdf_path: app.lease_pdf_url,
    });
  } catch (e) { console.error('sign_events insert failed (non-fatal):', (e as Error).message); }

  // Fully executed email to tenant
  try {
    const leaseData = (app.lease_start_date || app.monthly_rent || app.move_in_costs) ? {
      startDate:  app.lease_start_date || undefined,
      endDate:    app.lease_end_date   || undefined,
      rent:       app.monthly_rent     || undefined,
      deposit:    app.security_deposit || undefined,
      moveInCost: app.move_in_costs    || undefined,
    } : undefined;
    const execResult = await sendEmail({
      to:      app.email,
      subject: `\u{2713} Your Lease Has Been Fully Executed — Choice Properties (Ref: ${app.app_id})`,
      html:    leaseFullyExecutedHtml(app.first_name || 'Applicant', app.property_address || '', TENANT_LOGIN_URL, app.app_id, leaseData),
    });
    await logEmail(app_id, 'lease_fully_executed', app.email, execResult.ok ? 'sent' : 'failed', execResult.provider, execResult.ok ? null : (execResult.error || 'failed'));
  } catch (e) { console.error('Fully executed email failed (non-fatal):', (e as Error).message); }

  // Landlord notification — lease is fully executed
  try {
    const tenantName = `${app.first_name || ''} ${app.last_name || ''}`.trim();
    await sendLandlordEmail(
      supabase,
      app.property_id,
      `Lease Fully Executed — ${app.property_address || app_id}`,
      landlordLeaseExecutedHtml('', tenantName, app.property_address || '', app.lease_start_date || undefined, app_id, getAdminUrl('/admin/leases.html')),
    );
  } catch (_) {}

  try {
    await supabase.from('admin_actions').insert({
      action:      'management_countersign',
      target_type: 'application',
      target_id:   app_id,
      metadata:    { app_id, actor: signer_name, admin: auth.userEmail || null },
    });
  } catch (_) {}

  // Phase 10: also mirror the lease.lease_pdf_url after the countersigned PDF
  // has been written, so the leases row reflects the fully-executed pointer.
  if (mirroredLeaseId) {
    try {
      const { data: appFinal } = await supabase
        .from('applications').select('*').eq('app_id', app_id).single();
      if (appFinal) await mirrorAppToLease(supabase, appFinal, 'countersigned');
    } catch (_) { /* non-fatal */ }
  }

  return jsonOk({ success: true, app_id, lease_id: mirroredLeaseId, message: 'Lease countersigned by ' + signer_name });
});
