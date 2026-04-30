// Choice Properties - Shared: lease-addenda.ts
  //
  // Phase 04 - state-required disclosures library + auto-attach.
  //
  // Two helpers used by generate-lease and sign-lease:
  //
  //   selectRequiredAddenda(supabase, app, partials)
  //     -> resolves which addenda must attach to a given application
  //        based on lease state, property year_built/type, pet flag, etc.
  //        Renders each addendum body through the Phase 01 templating
  //        engine and returns a list of snapshots ready to insert into
  //        lease_addenda_attached.
  //
  //   The selector also reports any HARD-REQUIRED slug that is missing
  //   from the library (e.g. a state was added to property intake but
  //   its required addendum was never seeded). generate-lease refuses
  //   to issue a lease in that case rather than silently shipping an
  //   incomplete legal document.

  import { renderTemplate, type PartialResolver } from './template-engine.ts';
  import { buildLeaseRenderContext } from './lease-context.ts';

  type SupaClient = ReturnType<typeof import('npm:@supabase/supabase-js@2').createClient>;

  export interface AddendumLibraryRow {
    slug: string;
    title: string;
    jurisdiction: string;
    applies_when: Record<string, unknown>;
    body: string;
    attached_pdf_path: string | null;
    signature_required: boolean;
    initials_required: boolean;
    citation: string;
    source_url: string;
    legal_review_status: string;
    is_active: boolean;
  }

  export interface RenderedAddendum {
    slug: string;
    title: string;
    jurisdiction: string;
    citation: string;
    rendered_body: string;
    attached_pdf_path: string | null;
    signature_required: boolean;
    initials_required: boolean;
  }

  export interface SelectionResult {
    /** Addenda to attach (rendered + filtered). */
    attached: RenderedAddendum[];
    /** Hard-required slugs missing from the library. Non-empty = refuse. */
    missing_required: string[];
    /** Slugs filtered out by applies_when (diagnostic). */
    filtered_out: string[];
    /** Slugs that were considered as candidates (diagnostic). */
    candidate_slugs: string[];
  }

  /**
   * States that statutorily require a written move-in inventory or
   * itemized condition statement (CA Civ. §1950.5(f), GA O.C.G.A.
   * §44-7-33, KY KRS §383.580, MD RP §8-203.1, MA Ch.186
   * §15B, NH RSA 540-A:6, NJ A.3956, VA §55.1-1214,
   * WA RCW 59.18.260).
   */
  const MOVE_IN_INVENTORY_STATES = new Set([
    'CA','GA','KY','MD','MA','NH','NJ','VA','WA',
  ]);

  /**
   * Evaluate an addendum's applies_when JSONB predicate.
   * Recognized keys (Phase 04):
   *   property_built_before:            number (year)
   *   property_type:                    string[] (lowercase exact-match)
   *   requires_pets:                    boolean
   *   state_requires_move_in_inventory: boolean
   * Unknown keys default-pass (forward-compatible).
   */
  function evalAppliesWhen(
    predicate: Record<string, unknown>,
    ctx: {
      property_year_built: number | null;
      property_type:       string | null;
      has_pets:            boolean;
      state_requires_move_in_inventory: boolean;
    },
  ): boolean {
    for (const [k, v] of Object.entries(predicate || {})) {
      switch (k) {
        case 'property_built_before': {
          const before = Number(v);
          if (!isFinite(before)) continue;
          // Conservative: if year unknown, treat as "may apply" (better to
          // disclose than miss federal lead-paint).
          if (typeof ctx.property_year_built === 'number' && ctx.property_year_built >= before) return false;
          break;
        }
        case 'property_type': {
          if (!Array.isArray(v)) continue;
          const allow = (v as unknown[]).map((s) => String(s).toLowerCase());
          const t = (ctx.property_type || '').toLowerCase();
          if (t && !allow.includes(t)) return false;
          break;
        }
        case 'requires_pets':
          if (Boolean(v) !== Boolean(ctx.has_pets)) return false;
          break;
        case 'state_requires_move_in_inventory':
          if (Boolean(v) !== Boolean(ctx.state_requires_move_in_inventory)) return false;
          break;
        // Unknown keys: pass through (forward-compatible)
      }
    }
    return true;
  }

  export interface AppForAddenda {
    app_id:               string;
    lease_state_code:     string;            // validated 2-letter upstream
    has_pets?:            boolean | null;
    lease_pets_policy?:   string | null;
    property_year_built?: number | null;
    property_type?:       string | null;
    // Allow extra keys for templating context
    [key: string]:        unknown;
  }

  function computeCandidates(
    app: AppForAddenda,
    stateRequiresInventory: boolean,
  ): { candidates: Set<string>; hardRequired: Set<string> } {
    const candidates   = new Set<string>();
    const hardRequired = new Set<string>();

    // ---- Federal ----------------------------------------------------------
    candidates.add('federal/megans-law');
    hardRequired.add('federal/megans-law');

    // Lead-paint: ALWAYS a candidate; only HARD-required when we KNOW the
    // year is pre-1978. (When year is unknown, we still attach the addendum
    // because evalAppliesWhen passes-on-unknown - safer to disclose.)
    candidates.add('federal/lead-paint');
    if (typeof app.property_year_built === 'number' && app.property_year_built < 1978) {
      hardRequired.add('federal/lead-paint');
    }

    // ---- Common (multi-jurisdictional) -----------------------------------
    candidates.add('common/mold');
    candidates.add('common/smoke-co');
    hardRequired.add('common/mold');
    hardRequired.add('common/smoke-co');

    // ---- Choice Properties platform addenda (auto-attach on every lease) -
    // These are NOT hardRequired — a missing library entry skips them
    // gracefully rather than blocking lease generation.
    candidates.add('choice/quality-guarantee');
    candidates.add('choice/late-payment-policy');
    candidates.add('choice/tenant-promises');

    const hasPets = !!app.has_pets || /allow|yes|with deposit/i.test(app.lease_pets_policy || '');
    if (hasPets) {
      candidates.add('common/pet-addendum');
      hardRequired.add('common/pet-addendum');
    }

    if (stateRequiresInventory) {
      candidates.add('common/move-in-inventory');
      hardRequired.add('common/move-in-inventory');
    }

    return { candidates, hardRequired };
  }

  /**
   * Resolve the full set of addenda for an application: federal + common
   * + auto-loaded state-base set (every active library row whose
   * jurisdiction matches the lease state code), filtered by applies_when,
   * and rendered through the Phase 01 templating engine.
   */
  export async function selectRequiredAddenda(
    supabase: SupaClient,
    app: AppForAddenda,
    partials?: PartialResolver,
  ): Promise<SelectionResult> {
    const stateCode              = app.lease_state_code;
    const stateRequiresInventory = MOVE_IN_INVENTORY_STATES.has(stateCode);
    const { candidates, hardRequired } = computeCandidates(app, stateRequiresInventory);

    // Auto-load every active addendum for this state.
    const stateRowsRes = await supabase
      .from('lease_addenda_library')
      .select('slug')
      .eq('jurisdiction', stateCode)
      .eq('is_active', true);
    for (const r of (stateRowsRes.data ?? []) as { slug: string }[]) candidates.add(r.slug);

    const candidateSlugs = [...candidates].sort();

    // Bulk-load full rows for the candidate set.
    const libRowsRes = await supabase
      .from('lease_addenda_library')
      .select('*')
      .in('slug', candidateSlugs)
      .eq('is_active', true);
    const rowsBySlug = new Map<string, AddendumLibraryRow>();
    for (const r of (libRowsRes.data ?? []) as AddendumLibraryRow[]) rowsBySlug.set(r.slug, r);

    // Hard-required slugs must exist.
    const missing_required: string[] = [];
    for (const slug of hardRequired) if (!rowsBySlug.has(slug)) missing_required.push(slug);

    const renderCtx = buildLeaseRenderContext(app as unknown as Record<string, unknown>);
    const evalCtx = {
      property_year_built: app.property_year_built ?? null,
      property_type:       app.property_type ?? null,
      has_pets:            !!app.has_pets || /allow|yes|with deposit/i.test(app.lease_pets_policy || ''),
      state_requires_move_in_inventory: stateRequiresInventory,
    };

    const attached:    RenderedAddendum[] = [];
    const filtered_out: string[]          = [];

    for (const slug of candidateSlugs) {
      const row = rowsBySlug.get(slug);
      if (!row) { filtered_out.push(slug + ' (not in library)'); continue; }
      if (!evalAppliesWhen(row.applies_when || {}, evalCtx)) {
        filtered_out.push(slug);
        continue;
      }

      let rendered_body: string;
      try {
        rendered_body = await renderTemplate(row.body, renderCtx, { partials });
      } catch (e) {
        console.warn('[lease-addenda] render failed for', slug, (e as Error).message);
        rendered_body = row.body;
      }

      attached.push({
        slug:               row.slug,
        title:              row.title,
        jurisdiction:       row.jurisdiction,
        citation:           row.citation,
        rendered_body,
        attached_pdf_path:  row.attached_pdf_path,
        signature_required: row.signature_required,
        initials_required:  row.initials_required,
      });
    }

    return { attached, missing_required, filtered_out, candidate_slugs: candidateSlugs };
  }

  /**
   * Persist the per-application attachment snapshots. Idempotent on
   * (app_id, addendum_slug). Returns the inserted/updated count.
   */
  export async function persistAttachedAddenda(
    supabase: SupaClient,
    appId: string,
    applicationPk: number | null,
    addenda: RenderedAddendum[],
  ): Promise<{ ok: boolean; count: number; error?: string }> {
    if (addenda.length === 0) return { ok: true, count: 0 };

    const rows = addenda.map((a) => ({
      app_id:               appId,
      application_pk:       applicationPk,
      addendum_slug:        a.slug,
      addendum_title:       a.title,
      addendum_jurisdiction: a.jurisdiction,
      addendum_citation:    a.citation,
      rendered_body:        a.rendered_body,
      attached_pdf_path:    a.attached_pdf_path,
      signature_required:   a.signature_required,
      initials_required:    a.initials_required,
      attached_at:          new Date().toISOString(),
    }));

    const { error, count } = await supabase
      .from('lease_addenda_attached')
      .upsert(rows, { onConflict: 'app_id,addendum_slug', count: 'exact' });

    if (error) return { ok: false, count: 0, error: error.message };
    return { ok: true, count: count ?? rows.length };
  }

  /**
   * Fetch all addenda already attached to an application, in slug order.
   * Used by sign-lease to re-render the PDF and to record per-addendum ack.
   */
  export async function fetchAttachedAddenda(
    supabase: SupaClient,
    appId: string,
  ): Promise<RenderedAddendum[]> {
    const { data, error } = await supabase
      .from('lease_addenda_attached')
      .select('addendum_slug, addendum_title, addendum_jurisdiction, addendum_citation, rendered_body, attached_pdf_path, signature_required, initials_required')
      .eq('app_id', appId)
      .order('addendum_slug', { ascending: true });
    if (error || !data) return [];
    return (data as Array<Record<string, unknown>>).map((r) => ({
      slug:               r.addendum_slug as string,
      title:              r.addendum_title as string,
      jurisdiction:       r.addendum_jurisdiction as string,
      citation:           r.addendum_citation as string,
      rendered_body:      r.rendered_body as string,
      attached_pdf_path:  (r.attached_pdf_path as string | null) ?? null,
      signature_required: (r.signature_required as boolean) ?? true,
      initials_required:  (r.initials_required as boolean) ?? false,
    }));
  }

  /**
   * After a tenant or co-applicant signs the lease, mark every attached
   * addendum as acknowledged with the signing metadata. Single ack per
   * (app_id, addendum_slug) - once acknowledged it stays acknowledged
   * even if a later sign event fires (we keep the FIRST acknowledgment).
   */
  export async function recordAddendaAcknowledgment(
    supabase: SupaClient,
    appId: string,
    ack: {
      role:       'tenant' | 'co_applicant' | 'management';
      typed_name: string;
      ip:         string;
      user_agent: string;
      initials:   string | null;
    },
  ): Promise<{ ok: boolean; updated: number; error?: string }> {
    const { data, error } = await supabase
      .from('lease_addenda_attached')
      .update({
        acknowledged_by:         ack.typed_name,
        acknowledged_role:       ack.role,
        acknowledged_at:         new Date().toISOString(),
        acknowledged_ip:         ack.ip,
        acknowledged_user_agent: ack.user_agent,
        signature_text:          ack.typed_name,
        initials_text:           ack.initials,
      })
      .eq('app_id', appId)
      .is('acknowledged_at', null)
      .select('id');

    if (error) return { ok: false, updated: 0, error: error.message };
    return { ok: true, updated: (data ?? []).length };
  }

  export const __test_only__ = {
    evalAppliesWhen,
    computeCandidates,
    MOVE_IN_INVENTORY_STATES,
  };
  