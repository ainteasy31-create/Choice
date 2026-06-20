// ============================================================
// Choice Properties - Shared API Client (cp-api.js)
// All pages import this after config.js
// ============================================================

// ---- Dual-storage: persists the auth session in both localStorage AND a
// 72-hour cookie. On iOS Safari and Android Chrome, localStorage can be
// cleared by the browser's storage-pressure routines or when the user
// switches away for a long time. Keeping a cookie copy means the session
// survives those clears and the user stays logged in for the full 72 hours.
const _dualStorage = {
  _cn(key) {
    // Derive a safe, predictable cookie name from the storage key.
    return 'cpx_' + key.replace(/[^a-z0-9]/gi, '_');
  },
  getItem(key) {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) return v;
    } catch {}
    // localStorage miss — try cookie fallback
    try {
      const cn = this._cn(key);
      const match = document.cookie.match('(?:^|; )' + cn + '=([^;]*)');
      if (match) {
        const v = decodeURIComponent(match[1]);
        // Restore to localStorage so future reads stay fast
        try { localStorage.setItem(key, v); } catch {}
        return v;
      }
    } catch {}
    return null;
  },
  setItem(key, value) {
    try { localStorage.setItem(key, value); } catch {}
    // Write cookie backup only if payload fits within safe cookie limit (~4 KB).
    // Supabase session JSON is typically 1-2 KB encoded, well within this range.
    try {
      const encoded = encodeURIComponent(value);
      if (encoded.length <= 3800) {
        const cn = this._cn(key);
        document.cookie =
          cn + '=' + encoded +
          '; max-age=' + (72 * 3600) +
          '; path=/; SameSite=Lax';
      }
    } catch {}
  },
  removeItem(key) {
    try { localStorage.removeItem(key); } catch {}
    try {
      const cn = this._cn(key);
      document.cookie = cn + '=; max-age=0; path=/; SameSite=Lax';
    } catch {}
  },
};

// Supabase client (lazy singleton)
// I-065: Guard against the defer/module race condition.
// config.js and supabase.min.js are loaded with `defer`. ES modules also defer,
// but the spec does not guarantee defer-script order relative to module execution
// across all browsers (particularly mobile Safari and older WebViews). If sb() is
// called before window.supabase or CONFIG is ready, we throw a clear error instead
// of a cryptic "Cannot read properties of undefined" that silently kills uploads.
let _sb = null;

function sb() {
  if (!_sb) {
    if (!window.supabase) {
      throw new Error(
        'Supabase SDK not loaded yet. ' +
        'Ensure supabase.min.js defer script runs before cp-api.js.'
      );
    }
    if (typeof CONFIG === 'undefined' || !CONFIG.SUPABASE_URL) {
      throw new Error(
        'CONFIG not ready. ' +
        'Ensure config.js defer script runs before cp-api.js.'
      );
    }
    _sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // PKCE returns a refresh token. Without flowType, the SDK falls back to
        // implicit on hash-callback paths (notably password recovery), and
        // implicit tokens have no refresh — that's what was causing landlord
        // sessions to silently expire after 1 hour.
        flowType: 'pkce',
        // detectSessionInUrl is intentionally OFF here. The shared landlord
        // client should not auto-consume URL fragments, because the landlord
        // login page handles the recovery hash explicitly with setSession().
        // (Default storageKey kept so existing logged-in users aren't kicked.)
        detectSessionInUrl: false,
        // Dual storage: writes session to localStorage AND a 72-h cookie so
        // the session survives iOS/Android localStorage clears.
        storage: _dualStorage,
      }
    });
    // I-406: autoRefreshToken fires on every page load. When a stored refresh token
    // has expired or is invalid (e.g. after a long absence), the Supabase client
    // makes a background POST to /auth/v1/token that can return 406, which the
    // browser logs as an uncaught network error even though auth recovers gracefully.
    // Subscribing here means the SDK knows something is listening and handles the
    // failure path cleanly; the subscription itself is a no-op.
    _sb.auth.onAuthStateChange(() => {});
  }
  return _sb;
}

// -- Normalized return shape -------------------------------
// Every public API method returns { ok, data, error }.
//   ok    - boolean, true on success
//   data  - payload on success, null on failure
//   error - human-readable string on failure, null on success
//
// Internal helper - wraps a Supabase { data, error } pair.
function _ok(data, error) {
  if (error) return { ok: false, data: null, error: error.message || String(error) };
  return { ok: true, data: data ?? null, error: null };
}

// -- Auth helpers ------------------------------------------
const Auth = {
  async getUser() {
    // I-406: auth.getUser() always makes a server round-trip to validate the JWT.
    // For anonymous visitors (nothing in localStorage) this triggers an unnecessary
    // network request that can surface as a 406/401 console error when a stale token
    // exists. Check the local session first; only hit the server if we have a token.
    const { data: sd } = await sb().auth.getSession();
    if (!sd?.session) return null;
    const { data } = await sb().auth.getUser();
    return data?.user || null;
  },
  async getSession()    { const { data } = await sb().auth.getSession(); return data?.session || null; },
  // Returns a valid access token, or null if the session is invalid/expired.
  //
  // Strategy (updated):
  //   1. Read the cached session. If the access token has > 5 min remaining,
  //      return it immediately — no network call needed.
  //   2. Only call refreshSession() when the token is absent or within 5 min
  //      of expiry. This eliminates the “refresh token already used” race that
  //      caused random logouts when multiple tabs or concurrent API calls each
  //      triggered their own refresh rotation simultaneously.
  //   3. On network failure, fall back to the cached token rather than signing
  //      out — a connectivity blip should not kill an active session.
  //   4. Only sign out when Supabase explicitly rejects the refresh token
  //      (confirmed auth failure), not on transient network errors.
  //
  // I-407: In-flight lock coalesces concurrent callers into a single refresh
  // so they all share the result rather than each firing a separate rotation.
  _refreshLock: null,
  async getAccessToken() {
    if (Auth._refreshLock) return Auth._refreshLock;
    Auth._refreshLock = (async () => {
      // Step 1 — read cached session (no network call).
      let session = null;
      try {
        const { data: sd } = await sb().auth.getSession();
        session = sd?.session ?? null;
      } catch {}

      // Step 2 — return cached token if still fresh (> 5 min remaining).
      // Avoids unnecessary refresh-token rotations on every API call.
      if (session?.access_token && session.expires_at) {
        const secsLeft = session.expires_at - Math.floor(Date.now() / 1000);
        if (secsLeft > 300) return session.access_token;
      }

      // Step 3 — token missing or near expiry: refresh it now.
      let token = null;
      let refreshFailed = false;
      try {
        const { data: rd, error: re } = await sb().auth.refreshSession();
        token = rd?.session?.access_token ?? null;
        // I-064: only flag auth failure when the server explicitly rejected the token.
        if (!token && re) refreshFailed = true;
      } catch { /* network failure — fall through */ }

      // Step 4 — network failure fallback: return the cached token so the
      // request can still attempt to proceed rather than killing the session.
      if (!token && session?.access_token) {
        token = session.access_token;
      }

      if (!token) {
        // I-064: Only sign out on confirmed auth rejection, not network issues.
        if (refreshFailed) await sb().auth.signOut().catch(() => {});
        return null;
      }

      return token;
    })();
    try { return await Auth._refreshLock; }
    finally { Auth._refreshLock = null; }
  },
  async signOut() {
    await sb().auth.signOut();
    // Route to the correct login page based on current URL path
    const path = location.pathname;
    if (path.includes('/admin/'))                                                { location.href = '/admin/login.html'; }
    else if (path.includes('/tenant/') || path.includes('/lease-sign') || path.includes('/verify-lease')) { location.href = '/tenant/login.html'; }
    else                                                                         { location.href = '/landlord/login.html'; }
  },
  async isAdmin()       {
    const user = await Auth.getUser();
    if (!user) return false;
    const { data } = await sb().from('admin_roles').select('id').eq('user_id', user.id).maybeSingle();
    return !!data;
  },
  async requireLandlord(redirectTo = '../landlord/login.html') {
    const user = await Auth.getUser();
    if (!user) { location.href = redirectTo; return null; }
    // SECURITY DEFINER RPC — direct select('*') would 401 under
    // 000013 column GRANTs (PII cols are not granted to authenticated).
    const { data } = await sb().rpc('get_my_landlord_profile');
    if (!data || !data.id) { location.href = redirectTo; return null; }
    return data;
  },
  async requireAdmin(redirectTo = '/admin/login.html') {
    const isAdmin = await Auth.isAdmin();
    if (!isAdmin) { location.href = redirectTo; return false; }
    return true;
  },
};

// -- Edge Function caller ----------------------------------
// Returns { ok, data, error } - never throws.
async function callEdgeFunction(name, payload) {
  try {
    const session = await Auth.getSession();
    const token = session?.access_token || CONFIG.SUPABASE_ANON_KEY;
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    let json = {};
    try { json = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = json.error || json.message || res.statusText || `HTTP ${res.status}`;
      return { ok: false, data: null, error: msg };
    }
    // Edge Functions return { success, error, ...payload } - unwrap into our shape.
    if ('success' in json) {
      if (!json.success) return { ok: false, data: null, error: json.error || 'Unknown error' };
      const { success: _s, error: _e, ...rest } = json;
      return { ok: true, data: Object.keys(rest).length ? rest : null, error: null };
    }
    return { ok: true, data: json, error: null };
  } catch (err) {
    return { ok: false, data: null, error: err.message || String(err) };
  }
}
// -- Properties API ----------------------------------------
// Phase 3c cutover (2026-04-22): the legacy `properties.photo_urls` and
// `properties.photo_file_ids` columns were dropped. The `property_photos`
// table is now the source of truth. To keep every existing UI render site
// (card-builder.js, property.html, listings.html map, admin/landlord pages)
// working unchanged, every Properties fetch embeds `property_photos` and
// then derives the two legacy array shapes on the row before returning.
//
// PostgREST embeds the rows as `row.property_photos` (an array of objects).
// We sort by display_order client-side so the gallery order is stable.
function _attachPhotoArrays(row) {
  if (!row || typeof row !== 'object') return row;
  const photos = Array.isArray(row.property_photos) ? row.property_photos.slice() : [];
  photos.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  row.photo_urls     = photos.map(p => p.url).filter(Boolean);
  row.photo_file_ids = photos.map(p => p.file_id ?? null);
  if (row.landlords && !row.landlords.avatar_url) {
    row.landlords.avatar_url = '/assets/avatar-placeholder.svg';
  }
  return row;
}

// Standard select fragment used by every property fetch below.
const PROPERTIES_SELECT_FULL =
  '*, landlords(contact_name, business_name, avatar_url, verified), property_photos(url, file_id, display_order)';

const Properties = {
  // getListings - server-side filtered, sorted, paginated query for the listings page.
  // filters: { q, type, beds, min_beds, min_baths, min_rent, max_rent, pets, parking, available, sort, page, per_page }
  // Returns { ok, data: { rows, total, page, per_page, total_pages }, error }
  async getListings(filters = {}) {
    const PAGE_SIZE = filters.per_page || 24;
    const page = Math.max(1, filters.page || 1);
    const from = (page - 1) * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;

    let q = sb()
      .from('properties')
      .select(PROPERTIES_SELECT_FULL, { count: 'exact' })
      .eq('status', 'active');

    // Text search - uses the GIN-indexed search_tsv generated column.
    // Falls back to ilike on title only if the term contains characters
    // that would break tsquery (e.g. bare punctuation).
    if (filters.q) {
      const term = filters.q.trim();
      const safeForTs = /^[\w\s\-']+$/.test(term);
      if (safeForTs) {
        q = q.textSearch('search_tsv', term, { type: 'websearch', config: 'english' });
      } else {
        q = q.ilike('title', `%${term}%`);
      }
    }

    // Property type pill (apartment / house / condo / townhouse)
    if (filters.type && filters.type !== 'all' && !['pets','parking','available'].includes(filters.type)) {
      q = q.eq('property_type', filters.type);
    }
    // Special pills
    if (filters.type === 'pets')      q = q.eq('pets_allowed', true);
    if (filters.type === 'parking')   q = q.not('parking', 'is', null).neq('parking', '').neq('parking', 'None');
    // C1 FIX: "Move-in Ready" must also match properties where available_date IS NULL
    // (those are immediately available - landlords who didn't set a date).
    if (filters.type === 'available') q = q.or(`available_date.is.null,available_date.lte.${new Date().toISOString().slice(0,10)}`);

    // Bedrooms - exact match from quick filter, gte from advanced min_beds
    if (filters.beds !== undefined && filters.beds !== '') {
      const beds = parseInt(filters.beds);
      if (beds === 4) { q = q.gte('bedrooms', 4); }
      else            { q = q.eq('bedrooms', beds); }
    } else if (filters.min_beds !== undefined && filters.min_beds !== '') {
      q = q.gte('bedrooms', parseInt(filters.min_beds));
    }

    // Bathrooms
    if (filters.min_baths !== undefined && filters.min_baths !== '') {
      q = q.gte('bathrooms', parseFloat(filters.min_baths));
    }

    // Rent range
    if (filters.min_rent !== undefined && filters.min_rent !== '') {
      q = q.gte('monthly_rent', parseInt(filters.min_rent));
    }
    if (filters.max_rent !== undefined && filters.max_rent !== '') {
      q = q.lte('monthly_rent', parseInt(filters.max_rent));
    }

    // Laundry type filter
    if (filters.laundry_type) q = q.eq('laundry_type', filters.laundry_type);

    // Heating type filter
    if (filters.heating_type) q = q.eq('heating_type', filters.heating_type);

    // Pet type filter - checks if pet_types_allowed array contains the requested type
    if (filters.pet_type) q = q.contains('pet_types_allowed', [filters.pet_type]);

    // Sort
    switch (filters.sort) {
      case 'price_asc':  q = q.order('monthly_rent', { ascending: true });  break;
      case 'price_desc': q = q.order('monthly_rent', { ascending: false }); break;
      case 'beds_desc':  q = q.order('bedrooms', { ascending: false });      break;
      default:           q = q.order('created_at', { ascending: false });    break;
    }

    // Pagination
    q = q.range(from, to);

    const { data, error, count } = await q;
    if (error) return { ok: false, data: null, error: error.message };
    const total = count ?? 0;
    return {
      ok: true,
      error: null,
      data: {
        rows:        (data || []).map(_attachPhotoArrays),
        total,
        page,
        per_page:    PAGE_SIZE,
        total_pages: Math.ceil(total / PAGE_SIZE),
      },
    };
  },

  // getListingsAdmin — same shape as getListings but no status='active' constraint.
  // Uses the authenticated session so RLS properties_admin_all fires automatically.
  async getListingsAdmin(filters = {}) {
    const PAGE_SIZE = filters.per_page || 24;
    const page = Math.max(1, filters.page || 1);
    const from = (page - 1) * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;

    let q = sb()
      .from('properties')
      .select(PROPERTIES_SELECT_FULL, { count: 'exact' });

    if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status);
    if (filters.landlord) q = q.eq('landlord_id', filters.landlord);

    if (filters.q) {
      const term = filters.q.trim();
      const safeForTs = /^[\w\s\-']+$/.test(term);
      if (safeForTs) q = q.textSearch('search_tsv', term, { type: 'websearch', config: 'english' });
      else           q = q.ilike('title', `%${term}%`);
    }
    if (filters.beds !== undefined && filters.beds !== '') {
      const beds = parseInt(filters.beds);
      if (beds === 4) q = q.gte('bedrooms', 4);
      else            q = q.eq('bedrooms', beds);
    }
    if (filters.min_rent) q = q.gte('monthly_rent', parseInt(filters.min_rent));
    if (filters.max_rent) q = q.lte('monthly_rent', parseInt(filters.max_rent));

    switch (filters.sort) {
      case 'price_asc':  q = q.order('monthly_rent', { ascending: true });  break;
      case 'price_desc': q = q.order('monthly_rent', { ascending: false }); break;
      case 'beds_desc':  q = q.order('bedrooms',     { ascending: false }); break;
      default:           q = q.order('created_at',   { ascending: false }); break;
    }
    q = q.range(from, to);

    const { data, error, count } = await q;
    if (error) return { ok: false, data: null, error: error.message };
    const total = count ?? 0;
    return {
      ok: true, error: null,
      data: {
        rows:        (data || []).map(_attachPhotoArrays),
        total,
        page,
        per_page:    PAGE_SIZE,
        total_pages: Math.ceil(total / PAGE_SIZE),
      },
    };
  },

  async getAll(filters = {}) {
    let q = sb().from('properties').select(PROPERTIES_SELECT_FULL).order('created_at', { ascending: false });
    if (filters.status)    q = q.eq('status', filters.status);
    if (filters.landlord)  q = q.eq('landlord_id', filters.landlord);
    if (filters.bedrooms !== undefined && filters.bedrooms !== '') q = q.gte('bedrooms', filters.bedrooms);
    if (filters.max_rent)  q = q.lte('monthly_rent', filters.max_rent);
    if (filters.state)     q = q.eq('state', filters.state);
    const { data, error } = await q;
    return _ok((data || []).map(_attachPhotoArrays), error);
  },
  async getOne(id) {
    // landlords(*) would 401 once authenticated SELECT is column-restricted (000013).
    // Public landlord card only needs the safe-cols set granted to anon + authenticated.
    const { data, error } = await sb().from('properties').select('*, landlords(id, user_id, contact_name, business_name, avatar_url, verified, tagline), property_photos(url, file_id, display_order)').eq('id', id).single();
    if (data && data.landlords && !data.landlords.avatar_url) {
      data.landlords.avatar_url = '/assets/avatar-placeholder.svg';
    }
    if (data) _attachPhotoArrays(data);
    return _ok(data, error);
  },
  // I-026: NOTE - this method is not currently used by new-listing.html.
  // That page calls generate_property_id() RPC + .insert() directly so it
  // can cache the propId in localStorage for retry-safe photo uploads.
  // If you update the insert payload shape here, update new-listing.html too.
  // Future: accept an optional pre-generated id param to unify both paths.
  async create(payload)   {
    const { data: newId, error: idErr } = await sb().rpc('generate_property_id');
    if (idErr || !newId) return { ok: false, data: null, error: idErr?.message || 'Failed to generate property ID' };
    const { data, error } = await sb().from('properties').insert({ ...payload, id: newId }).select().single();
    return _ok(data, error);
  },
  async update(id, payload) {
    const { data, error } = await sb().from('properties').update(payload).eq('id', id).select().single();
    return _ok(data, error);
  },
  async delete(id)        { return sb().from('properties').delete().eq('id', id); },
  async incrementView(id) { return sb().rpc('increment_counter', { p_table: 'properties', p_id: id, p_column: 'views_count' }); },
};

// -- Saved Properties API ----------------------------------
// C4 FIX: Connects the heart/save button to the saved_properties DB table
// for authenticated users (saves persist across devices).  Falls back to
// localStorage for anonymous visitors so the experience still works.
// The DB trigger trg_saves_count() auto-updates properties.saves_count on INSERT/DELETE.
const SavedProperties = {
  // Load saved property IDs for the current user.
  // Authenticated - DB query; anonymous - localStorage.
  // Always returns a Set<string>.
  async getIds() {
    const user = await Auth.getUser();
    if (!user) return new Set(JSON.parse(localStorage.getItem('cp_saved') || '[]'));
    const { data, error } = await sb()
      .from('saved_properties')
      .select('property_id')
      .eq('user_id', user.id);
    if (error) return new Set(JSON.parse(localStorage.getItem('cp_saved') || '[]'));
    return new Set((data || []).map(r => r.property_id));
  },

  // Toggle save state for one property.
  // Returns { saved: boolean }.
  async toggle(propertyId) {
    const user = await Auth.getUser();
    if (!user) {
      // Anonymous - localStorage only
      const ids = new Set(JSON.parse(localStorage.getItem('cp_saved') || '[]'));
      const saved = !ids.has(propertyId);
      if (saved) ids.add(propertyId); else ids.delete(propertyId);
      localStorage.setItem('cp_saved', JSON.stringify([...ids]));
      return { saved };
    }
    // Authenticated - check DB first to determine current state
    const { data: existing } = await sb()
      .from('saved_properties')
      .select('id')
      .eq('user_id', user.id)
      .eq('property_id', propertyId)
      .maybeSingle();
    let saved;
    if (existing) {
      // Currently saved - unsave (delete row; trigger decrements saves_count)
      await sb().from('saved_properties').delete().eq('id', existing.id);
      saved = false;
    } else {
      // Not saved - save (insert row; trigger increments saves_count)
      await sb().from('saved_properties').insert({ user_id: user.id, property_id: propertyId });
      saved = true;
    }
    // Keep localStorage in sync so anonymous fallback stays accurate
    const ids = new Set(JSON.parse(localStorage.getItem('cp_saved') || '[]'));
    if (saved) ids.add(propertyId); else ids.delete(propertyId);
    localStorage.setItem('cp_saved', JSON.stringify([...ids]));
    return { saved };
  },
};

// -- Inquiries API -----------------------------------------
const Inquiries = {
  async submit(payload)       {
    // Client-side throttle: max 1 inquiry per 60 s per browser session.
    // The send-inquiry Edge Function enforces a stricter server-side IP rate limit
    // (5 per 5 min), so this is just a fast-path guard for accidental double-submits.
    const THROTTLE_KEY = 'cp_inquiry_last';
    const last = parseInt(localStorage.getItem(THROTTLE_KEY) || '0', 10);
    if (Date.now() - last < 60000) {
      return { ok: false, data: null, error: 'Please wait a moment before sending another inquiry.' };
    }
    // C-04 FIX: All inquiry submissions now go through the Edge Function only.
    // The Edge Function uses the service-role key for the DB insert, so the anon
    // role no longer needs INSERT on the inquiries table. This closes the bypass
    // where anyone with the public anon key could insert directly via the REST API,
    // circumventing server-side rate limiting entirely.
    const result = await callEdgeFunction('send-inquiry', {
      type:            'new_inquiry',
      tenant_name:     payload.tenant_name,
      tenant_email:    payload.tenant_email,
      tenant_language: payload.tenant_language || (typeof localStorage !== 'undefined' ? localStorage.getItem('cp_lang') : null) || 'en',
      message:         payload.message,
      property_id:     payload.property_id,
      tenant_phone:    payload.tenant_phone || null,
      // Pass all remaining fields so the Edge Function can do the full insert
      insert_payload:  payload,
    });
    if (result?.ok) {
      localStorage.setItem(THROTTLE_KEY, String(Date.now()));
    }
    return result;
  },
  async getForLandlord(landlordId) {
    // Single query: PostgREST !inner join filters inquiries to only those
    // whose property.landlord_id matches - no separate property-ID fetch needed.
    const { data, error } = await sb()
      .from('inquiries')
      .select('*, properties!inner(id, title, address, landlord_id)')
      .eq('properties.landlord_id', landlordId)
      .order('created_at', { ascending: false });
    return _ok(data || [], error);
  },
  async markRead(id) { return sb().from('inquiries').update({ read: true }).eq('id', id); },
};

// -- Landlords API -----------------------------------------
const Landlords = {
  async getProfile(userId)  {
    // userId param is honoured for backwards compatibility but the RPC
    // ignores it — it always returns auth.uid()'s own row. All current
    // call sites pass the current user's id (Auth.getUser().id) anyway.
    const { data, error } = await sb().rpc('get_my_landlord_profile');
    if (error) return _ok(null, error);
    return _ok(data && data.id ? data : null, null);
  },
  async update(id, payload) {
    // SECURITY DEFINER RPC enforces own-row ownership and field whitelist.
    // The id param is kept for signature stability — RPC routes by auth.uid().
    const { data, error } = await sb().rpc('update_my_landlord_profile', { payload });
    return _ok(data, error);
  },
  async getAll(filters = {})            {
    const perPage = filters.perPage || 50;
    const page    = filters.page    || 0;
    // Admin RPC enforces admin role check. Direct .select('*') would 401
    // for non-admin authenticated users (and even admins under 000013
    // column GRANTs since admin_roles is checked at row level, not column).
    const { data, error } = await sb().rpc('admin_list_landlords', { p_page: page, p_per_page: perPage });
    if (error) return { ok: false, data: null, error: error.message };
    return { ok: true, data: data?.rows || [], error: null, count: data?.total || 0, page, perPage };
  },
};

// -- Email Logs API ----------------------------------------
const EmailLogs = {
  async getAll(filters = {}) {
    const perPage = filters.perPage || 50;
    const page    = filters.page    || 0;
    let q = sb().from('email_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(page * perPage, (page + 1) * perPage - 1);
    if (filters.app_id)  q = q.eq('app_id', filters.app_id);
    if (filters.type)    q = q.eq('type', filters.type);
    if (filters.status)  q = q.eq('status', filters.status);
    const { data, error, count } = await q;
    if (error) return { ok: false, data: null, error: error.message };
    return { ok: true, data: data || [], error: null, count: count || 0, page, perPage };
  },
};


// -- UI utilities ------------------------------------------
const UI = {
  fmt: {
    currency: (n) => `$${parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    date:     (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '-',
    dateTime: (d) => d ? new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-',
    status:   (s) => s ? s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '-',
    phone:    (p) => p ? p.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3') : '',
  },
  statusBadge(status) {
    const map = {
      pending:      'badge-warning',
      under_review: 'badge-info',
      approved:     'badge-success',
      denied:       'badge-danger',
      withdrawn:    'badge-secondary',
      waitlisted:   'badge-secondary',
    };
    return `<span class="badge ${map[status] || 'badge-secondary'}">${UI.fmt.status(status)}</span>`;
  },
  paymentBadge(status) {
    const map = { unpaid:'badge-danger', paid:'badge-success', waived:'badge-info', refunded:'badge-warning' };
    return `<span class="badge ${map[status] || 'badge-secondary'}">${UI.fmt.status(status)}</span>`;
  },
  leaseBadge(status) {
    const map = { none:'badge-secondary', sent:'badge-info', signed:'badge-success', awaiting_co_sign:'badge-warning', co_signed:'badge-success', voided:'badge-danger', expired:'badge-warning' };
    return `<span class="badge ${map[status] || 'badge-secondary'}">${UI.fmt.status(status)}</span>`;
  },
  toast(msg, type = 'info', duration = 4000) {
    const t = document.createElement('div');
    t.className = `cp-toast cp-toast-${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, duration);
  },
  loading(el, on) {
    if (on) { el.dataset.origText = el.textContent; el.disabled = true; el.textContent = 'Loading...'; }
    else    { el.textContent = el.dataset.origText || el.textContent; el.disabled = false; }
  },
  // Promise-based confirm dialog - replaces native confirm() with inline modal
  cpConfirm(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      const existing = document.getElementById('_cpConfirmOverlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = '_cpConfirmOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';

      const btnColor = danger ? '#dc2626' : 'var(--gold,#c9a84c)';
      const dialog = document.createElement('div');
      dialog.style.cssText = 'background:var(--surface,#1a2332);border:1px solid var(--border,#2a3a4a);border-radius:12px;max-width:440px;width:100%;padding:28px;box-shadow:0 24px 64px rgba(0,0,0,.5);';
      const body = document.createElement('div');
      body.style.cssText = 'font-size:.95rem;font-weight:600;color:var(--text,#e8eaf0);line-height:1.6;margin-bottom:24px;';
      body.textContent = message;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';
      const cancelBtn = document.createElement('button');
      cancelBtn.id = '_cpConfirmCancel';
      cancelBtn.style.cssText = 'background:transparent;border:1px solid var(--border,#2a3a4a);color:var(--muted,#8892a2);border-radius:6px;padding:9px 18px;font-size:.82rem;font-weight:600;cursor:pointer;';
      cancelBtn.textContent = cancelLabel;
      const okBtn = document.createElement('button');
      okBtn.id = '_cpConfirmOk';
      okBtn.style.cssText = `background:${btnColor};border:none;color:${danger ? '#fff' : '#0e1825'};border-radius:6px;padding:9px 18px;font-size:.82rem;font-weight:600;cursor:pointer;`;
      okBtn.textContent = confirmLabel;
      actions.replaceChildren(cancelBtn, okBtn);
      dialog.replaceChildren(body, actions);
      overlay.replaceChildren(dialog);

      document.body.appendChild(overlay);

      const cleanup = (val) => { overlay.remove(); resolve(val); };
      document.getElementById('_cpConfirmOk').addEventListener('click', () => cleanup(true));
      document.getElementById('_cpConfirmCancel').addEventListener('click', () => cleanup(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    });
  },

  // -- LQIP - returns a tiny blurred ImageKit URL for blur-up loading ---------
  // Usage: img.style.backgroundImage = `url(${CP.UI.lqipUrl(url)})`;
  // Returns null if ImageKit is not configured (safe to ignore).
  lqipUrl(url) {
    if (!url || !window.CONFIG || !CONFIG.IMAGEKIT_URL || CONFIG.IMAGEKIT_URL === '') return null;
    const base = url.startsWith(CONFIG.IMAGEKIT_URL)
      ? url.replace(/\/tr:[^/]+/, '')
      : CONFIG.IMAGEKIT_URL + '/' + encodeURIComponent(url);
    return base.replace(CONFIG.IMAGEKIT_URL, CONFIG.IMAGEKIT_URL + '/tr:w-30,bl-20,q-20,f-webp');
  },

  // -- Table skeleton rows (shimmer placeholders while data loads) ----------
  // Usage: tbody.innerHTML = CP.UI.skeletonRows(5, 6);
  // cols  - number of <td> cells per row (match your table's column count)
  // rows  - number of placeholder rows to show (default 5)
  skeletonRows(rows = 5, cols = 4) {
    const cells = Array(cols).fill('<td><div class="sk-cell"></div></td>').join('');
    return Array(rows).fill(`<tr class="sk-row">${cells}</tr>`).join('');
  },

  // -- Empty state for tables (no results) ---------------------------------
  // Usage (table): tbody.innerHTML = CP.UI.emptyState('No applications yet', '*', cols);
  // Usage (div):   container.innerHTML = CP.UI.emptyState('No messages yet', '*');
  // If cols is provided, wraps in a single <tr><td colspan="cols"> for table use.
  emptyState(message, icon = '*', cols = 0) {
    const inner = `<div class="cp-empty-state"><span class="cp-empty-icon">${icon}</span><span class="cp-empty-msg">${message}</span></div>`;
    return cols ? `<tr><td colspan="${cols}">${inner}</td></tr>` : inner;
  },

  // -- Error state for tables / divs (load failure) -------------------------
  // Usage (table): tbody.innerHTML = CP.UI.errorState('Failed to load data', cols);
  // Usage (div):   container.innerHTML = CP.UI.errorState('Failed to load data');
  errorState(message = 'Failed to load data. Please refresh and try again.', cols = 0) {
    const inner = `<div class="cp-error-state"><span class="cp-error-icon">!</span><span class="cp-error-msg">${message}</span></div>`;
    return cols ? `<tr><td colspan="${cols}">${inner}</td></tr>` : inner;
  },
};

// -- XSS-safe HTML escape ---------------------------------
// Use esc() whenever injecting user-supplied text into innerHTML.
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -- Landlord helper functions -----------------------------
// Defined here so they live in one place and are accessible
// via both window.CP (inline scripts) and ES named exports below.

function buildApplyURL(property) {
  // -- Layer 1: sessionStorage (same-origin only) ----------------------------
  // Stores full context for same-origin use. Legacy cross-origin forms
  // cannot read sessionStorage - they rely entirely on the URL params below.
  // landlord_id is included here only - never in the URL.
  try {
    sessionStorage.setItem('cp_property_context', JSON.stringify({
      id:               property.id,
      title:            property.title,
      address:          property.address,
      city:             property.city,
      state:            property.state,
      zip:              property.zip              || '',
      monthly_rent:     property.monthly_rent     || null,
      security_deposit: property.security_deposit || null,
      application_fee:  property.application_fee  || 50,
      available_date:   property.available_date   || null,
      landlord_id:      property.landlord_id      || null,
      bedrooms:         property.bedrooms         || null,
      bathrooms:        property.bathrooms        || null,
      lease_terms:      property.lease_terms      || [],
      minimum_lease_months: property.minimum_lease_months || null,
      pets_allowed:     property.pets_allowed     ?? false,
      pet_types_allowed:property.pet_types_allowed|| [],
      pet_weight_limit: property.pet_weight_limit || null,
      pet_deposit:      property.pet_deposit      || null,
      pet_details:      property.pet_details      || null,
      smoking_allowed:  property.smoking_allowed  ?? false,
      utilities_included: property.utilities_included || [],
      parking:          property.parking          || null,
      parking_fee:      property.parking_fee      || null,
      garage_spaces:    property.garage_spaces    || null,
      ev_charging:      property.ev_charging      || null,
      laundry_type:     property.laundry_type     || null,
      heating_type:     property.heating_type     || null,
      cooling_type:     property.cooling_type     || null,
      last_months_rent: property.last_months_rent || null,
      admin_fee:        property.admin_fee        || null,
      move_in_special:  property.move_in_special  || null,
    }));
  } catch (_) {
    // sessionStorage unavailable (private browsing) - URL params are the fallback.
  }

  // -- Layer 2: URL query params (cross-origin safe) -------------------------
  // Structured, machine-readable values so the apply form can:
  //   -¢ Pre-fill fields from the property data
  //   -¢ Restrict choices to only what this property allows (lease terms, pets, etc.)
  //   -¢ Enforce move-in date minimums from available_date
  //   -¢ Show/hide sections based on boolean flags (pets, smoking)
  //
  // landlord_id is NEVER included - resolved server-side from property_id.
  // Arrays use pipe "|" as a separator for multi-value params.
  const p = new URLSearchParams();

  // -- Identity & location ---------------------------------------------------
  p.set('id',    property.id);
  if (property.title)   p.set('pn',    property.title.substring(0, 120));
  if (property.address) p.set('addr',  property.address.substring(0, 100));
  if (property.city)    p.set('city',  property.city);
  if (property.state)   p.set('state', property.state);
  if (property.zip)     p.set('zip',   property.zip);

  // -- Financials ------------------------------------------------------------
  if (property.monthly_rent)     p.set('rent',    property.monthly_rent);
  if (property.security_deposit) p.set('deposit', property.security_deposit);
  p.set('fee', property.application_fee != null ? property.application_fee : 0); // 9C-1: always send fee, even if zero

  // -- Unit details ----------------------------------------------------------
  if (property.bedrooms  != null) p.set('beds',  property.bedrooms);
  if (property.bathrooms != null) p.set('baths', property.bathrooms);

  // -- Availability & lease terms --------------------------------------------
  // avail: ISO date string - the form uses as the minimum allowed move-in date.
  // terms: pipe-separated list of allowed lease term options - the form builds a
  //        constrained dropdown/radio group from this, hiding disallowed options.
  // min_months: numeric minimum - fallback when lease_terms array is empty.
  if (property.available_date) p.set('avail', property.available_date);

  if (property.lease_terms && property.lease_terms.length) {
    const terms = Array.isArray(property.lease_terms)
      ? property.lease_terms.join('|')
      : property.lease_terms;
    p.set('terms', terms);
  } else if (property.minimum_lease_months) {
    p.set('terms',      `${property.minimum_lease_months} months`);
    p.set('min_months', property.minimum_lease_months);
  }
  if (property.minimum_lease_months) p.set('min_months', property.minimum_lease_months);

  // -- Pet policy ------------------------------------------------------------
  // pets: boolean string "true"/"false" - shows/hides the pet section.
  // pet_types: pipe-separated allowed pet types - used for form validation.
  // pet_weight: numeric max weight in lbs - validated on the form.
  // pet_deposit: numeric - displayed as expected cost in the pet section.
  p.set('pets', property.pets_allowed ? 'true' : 'false');
  if (property.pets_allowed) {
    if (property.pet_types_allowed && property.pet_types_allowed.length) {
      const types = Array.isArray(property.pet_types_allowed)
        ? property.pet_types_allowed.join('|')
        : property.pet_types_allowed;
      p.set('pet_types', types);
    }
    if (property.pet_weight_limit) p.set('pet_weight',  property.pet_weight_limit);
    if (property.pet_deposit)      p.set('pet_deposit', property.pet_deposit);
    if (property.pet_details)      p.set('pet_details', property.pet_details.substring(0, 200));
  }

  // -- Smoking policy --------------------------------------------------------
  // smoking: boolean string "true"/"false" - pre-sets and locks the field.
  p.set('smoking', property.smoking_allowed ? 'true' : 'false');

  // -- Utilities & parking ---------------------------------------------------
  // utilities: pipe-separated list - displayed as included utilities context.
  // parking: text value - displayed as parking info context.
  if (property.utilities_included && property.utilities_included.length) {
    const utils = Array.isArray(property.utilities_included)
      ? property.utilities_included.join('|')
      : property.utilities_included;
    p.set('utilities', utils);
  }
  if (property.parking)     p.set('parking',     property.parking);
  if (property.parking_fee) p.set('parking_fee', property.parking_fee);
  if (property.garage_spaces) p.set('garage_spaces', property.garage_spaces);
  if (property.ev_charging && property.ev_charging !== 'none') p.set('ev_charging', property.ev_charging);
  if (property.laundry_type) p.set('laundry_type', property.laundry_type);
  if (property.heating_type) p.set('heating_type', property.heating_type);
  if (property.cooling_type) p.set('cooling_type', property.cooling_type);

  // -- Financial move-in costs ---------------------------------------------------
  if (property.last_months_rent) p.set('last_months_rent', property.last_months_rent);
  if (property.admin_fee)        p.set('admin_fee',        property.admin_fee);
  if (property.move_in_special)  p.set('move_in_special',  property.move_in_special.substring(0, 200));

  // -- Resolve target base URL -----------------------------------------------
  const base = (typeof CONFIG !== 'undefined' && CONFIG.APPLY_FORM_URL)
    ? CONFIG.APPLY_FORM_URL
    : '/apply';

  // 9C-2: pass current page URL so apply form can show 'Back to listing' link
  try { p.set('source', window.location.href.substring(0, 300)); } catch (_) {}

    // B2: Guard URL length — if over 7000 chars, drop optional free-text fields and retry
      let _finalUrl = `${base}?${p.toString()}`;
      if (_finalUrl.length > 7000) {
        console.warn('[buildApplyURL] URL length ' + _finalUrl.length + ' chars — dropping optional params to reduce size');
        ['pet_details', 'move_in_special', 'source', 'utilities', 'parking', 'laundry_type', 'heating_type', 'cooling_type'].forEach(k => p.delete(k));
        _finalUrl = `${base}?${p.toString()}`;
        if (_finalUrl.length > 7000) {
          console.warn('[buildApplyURL] URL still ' + _finalUrl.length + ' chars after reduction — may truncate on some browsers');
        }
      }
      return _finalUrl;
    }

async function incrementCounter(table, id, column) {
  return sb().rpc('increment_counter', { p_table: table, p_id: id, p_column: column });
}

async function getSession()         { return Auth.getSession(); }
async function getLandlordProfile() { const user = await Auth.getUser(); if (!user) return null; return (await Landlords.getProfile(user.id)).data; }
async function requireAuth(r)       { return Auth.requireLandlord(r); }
async function signIn(e, p)         { const { data, error } = await sb().auth.signInWithPassword({ email: e, password: p }); if (error) throw error; return data; }
async function signUp(email, password, profile) {
  const { data, error } = await sb().auth.signUp({ email, password, options: { data: profile } });
  if (error) throw error;
  if (data.user) {
    const { error: pe } = await sb().from('landlords').insert({ user_id: data.user.id, email, contact_name: profile.contact_name, business_name: profile.business_name || null, phone: profile.phone || null, account_type: profile.account_type || 'landlord', avatar_url: profile.avatar_url || null });
    if (pe) {
      // Auth user was created but profile insert failed. Sign out the orphaned session
      // so the user can retry registration cleanly without being stuck in a half-logged-in state.
      await sb().auth.signOut();
      throw new Error('Account setup failed: ' + pe.message + '. Please try registering again.');
    }
  }
  return data;
}
async function signOut() {
  await sb().auth.signOut();
  const isAdminPath = window.location.pathname.includes('/admin/');
  window.location.href = isAdminPath ? '/admin/login.html' : '/landlord/login.html';
}
async function resetPassword(email, redirectPath = '/landlord/login.html') { const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${redirectPath}` }); if (error) throw error; }
async function updateNav() {
  const session    = await Auth.getSession();
  const authLink   = document.getElementById('navAuthLink');
  const drawerLink = document.getElementById('drawerAuthLink');
  if (session) {
    if (authLink)   { authLink.href   = '/landlord/dashboard.html'; authLink.textContent   = 'My Dashboard'; }
    if (drawerLink) { drawerLink.href = '/landlord/dashboard.html'; drawerLink.textContent = 'My Dashboard'; }
  } else {
    if (authLink)   { authLink.href   = '/landlord/register.html'; authLink.textContent   = 'List Your Property'; }
    if (drawerLink) { drawerLink.href = '/landlord/login.html';    drawerLink.textContent = 'Landlord Login'; }
  }
}

// -- Single source of truth: window.CP --------------------
// Admin pages, apply.js, and inline <script> blocks all read
// from window.CP. ES exports below are thin re-exports - they
// add no logic of their own, so there is only ONE place to
// edit when adding or changing any function.

  // ── Applications API ─────────────────────────────────────────
  // Reads/writes to the Supabase applications table.
  // Used by admin pages: applications.html, leases.html, move-ins.html.
  // These are admin-only methods used by admin/applications.html, leases.html, move-ins.html.
  const Applications = {
    async getAll(filters = {}) {
      let q = sb()
        .from('applications')
        .select(
          'id,app_id,created_at,updated_at,status,payment_status,payment_date,' +
          'admin_notes,application_fee,property_id,property_address,' +
          'first_name,last_name,email,phone,dob,ssn,' +
          'requested_move_in_date,desired_lease_term,' +
          'current_address,residency_duration,current_rent_amount,reason_for_leaving,' +
          'current_landlord_name,landlord_phone,' +
          'previous_address,previous_residency_duration,previous_landlord_name,previous_landlord_phone,' +
          'employment_status,employer,employer_address,job_title,employment_start_date,employment_duration,' +
          'supervisor_name,supervisor_phone,' +
          'monthly_income,other_income,' +
          'has_bankruptcy,bankruptcy_explanation,has_criminal_history,criminal_history_explanation,' +
          'government_id_type,government_id_number,' +
          'reference_1_name,reference_1_phone,reference_2_name,reference_2_phone,' +
          'emergency_contact_name,emergency_contact_phone,emergency_contact_relationship,' +
          'primary_payment_method,primary_payment_method_other,' +
          'alternative_payment_method,alternative_payment_method_other,' +
          'third_choice_payment_method,third_choice_payment_method_other,' +
          'has_pets,pet_details,total_occupants,additional_occupants,ever_evicted,smoker,' +
          'preferred_contact_method,preferred_time,' +
          'vehicle_make,vehicle_model,vehicle_year,vehicle_license_plate,' +
          'has_co_applicant,co_applicant_ssn,landlord_email,document_urls,' +
          'lease_status,lease_sent_date,lease_signed_date,lease_start_date,lease_end_date,' +
          'monthly_rent,security_deposit,move_in_costs,lease_notes,lease_pdf_url,' +
          'tenant_signature,signature_timestamp,' +
          'move_in_status,move_in_date_actual,move_in_notes,move_in_confirmed_by,' +
          'payment_amount_recorded,payment_method_recorded,payment_notes,' +
          'holding_fee_requested,holding_fee_requested_at,holding_fee_amount,' +
          'holding_fee_due_date,holding_fee_paid,holding_fee_paid_at,' +
          'management_signed,management_signer_name,management_signed_at,management_notes,' +
          'management_cosigned,management_cosigned_by,management_cosigned_at,' +
          'first_month_rent,last_month_rent,pet_deposit,pet_rent,admin_fee,' +
          'key_deposit,parking_fee,cleaning_fee,cleaning_fee_refundable,' +
          'lease_late_fee_flat,lease_state_code,lease_landlord_name,lease_landlord_address,' +
          'rent_due_day_of_month,rent_proration_method,' +
          'utility_responsibilities,move_out_date_actual,prorated_first_month'
        )
        .order('created_at', { ascending: false });

      if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status);
      else q = q.neq('status', 'archived'); // hide archived from the default "All" view
      if (filters.lease_status && filters.lease_status !== 'all') q = q.eq('lease_status', filters.lease_status);
      if (filters.move_in_status && filters.move_in_status !== 'all') q = q.eq('move_in_status', filters.move_in_status);
      if (filters.payment_status) q = q.eq('payment_status', filters.payment_status);
      if (filters.property_id) q = q.eq('property_id', filters.property_id);
      if (filters.search) {
        const s = filters.search.trim().replace(/'/g, "''");
        q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,app_id.ilike.%${s}%,property_address.ilike.%${s}%`);
      }
      if (filters.limit)  q = q.limit(filters.limit);
      if (filters.offset && filters.limit) q = q.range(filters.offset, filters.offset + filters.limit - 1);

      const { data, error } = await q;
      return _ok(data || [], error);
    },

    async getOne(id) {
      const { data, error } = await sb().from('applications').select('*').eq('id', id).single();
      return _ok(data, error);
    },

    // Internal: fire a status/payment notification email via the send-email
    // edge function. Failures are logged but never block the underlying DB
    // update — the admin will see the new state immediately and can use the
    // "Resend" button if email delivery failed.
    async _sendNotification(appRowOrId, type, extra) {
      try {
        // Resolve to app_id (the public ref) if caller passed the row's UUID.
        let appId = null;
        if (appRowOrId && typeof appRowOrId === 'object') {
          appId = appRowOrId.app_id;
        } else {
          const { data } = await sb().from('applications').select('app_id').eq('id', appRowOrId).maybeSingle();
          appId = data?.app_id || null;
        }
        if (!appId) return { ok: false, error: 'No app_id resolvable for notification' };
        return await callEdgeFunction('send-email', { app_id: appId, type, ...(extra || {}) });
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },

    // STATUS_EMAIL_TYPES: which statuses trigger an automated tenant email.
    // Keep this in sync with supported types in supabase/functions/send-email/index.ts.
    _STATUS_EMAIL_TYPES: { approved: 'approved', denied: 'denied', waitlisted: 'waitlisted' },

    async updateStatus(id, status, adminNotes, options) {
      const opts = options || {};
      const patch = { status, updated_at: new Date().toISOString() };
      if (adminNotes !== undefined) patch.admin_notes = adminNotes;
      const { data, error } = await sb().from('applications').update(patch).eq('id', id).select('id,app_id,status,admin_notes,updated_at').single();
      const result = _ok(data, error);
      // Fire automated status email (approved/denied/waitlisted) unless caller opts out.
      if (result.ok && opts.sendEmail !== false) {
        const type = Applications._STATUS_EMAIL_TYPES[status];
        if (type) {
          const email = await Applications._sendNotification(data, type, adminNotes ? { message: adminNotes } : undefined);
          result.emailSent = !!email.ok;
          if (!email.ok) result.emailError = email.error;
        }
      }
      return result;
    },

    async updatePayment(id, paymentStatus, options) {
      const opts = options || {};
      const patch = { payment_status: paymentStatus, payment_date: paymentStatus === 'paid' ? new Date().toISOString() : null, updated_at: new Date().toISOString() };
      const { data, error } = await sb().from('applications').update(patch).eq('id', id).select('id,app_id,payment_status,payment_date').single();
      const result = _ok(data, error);
      if (result.ok && paymentStatus === 'paid' && opts.sendEmail !== false) {
        const email = await Applications._sendNotification(data, 'payment_confirmed');
        result.emailSent = !!email.ok;
        if (!email.ok) result.emailError = email.error;
      }
      return result;
    },

    async updatePaymentWithDetails(id, paymentStatus, amount, method, notes, options) {
      const opts = options || {};
      const now = new Date().toISOString();
      const patch = {
        payment_status: paymentStatus,
        payment_date: paymentStatus === 'paid' ? now : null,
        updated_at: now,
      };
      // Manual recording IS the confirmation in our workflow — keep both
      // column families (_recorded and _collected/_confirmed) in sync so
      // tenant_portal_state RPC and the tenant portal display the right
      // values. (Audit fix M-1, 2026-04-27.)
      if (amount  != null) {
        patch.payment_amount_recorded  = amount;
        patch.payment_amount_collected = amount;
      }
      if (method) {
        patch.payment_method_recorded  = method;
        patch.payment_method_confirmed = method;
      }
      if (notes) patch.payment_notes = notes;
      if (paymentStatus === 'paid') patch.payment_confirmed_at = now;
      const { data, error } = await sb().from('applications')
        .update(patch).eq('id', id)
        .select('id,app_id,payment_status,payment_date,payment_confirmed_at,payment_amount_recorded,payment_amount_collected,payment_method_recorded,payment_method_confirmed,payment_notes').single();
      const result = _ok(data, error);
      if (result.ok && paymentStatus === 'paid' && opts.sendEmail !== false) {
        const email = await Applications._sendNotification(data, 'payment_confirmed', {
          amount_collected: amount,
          payment_method:  method,
        });
        result.emailSent = !!email.ok;
        if (!email.ok) result.emailError = email.error;
      }
      return result;
    },

    async getLandlordApplications(landlordId) {
      const { data, error } = await sb()
        .from('applications')
        .select(
          'id,app_id,created_at,updated_at,status,payment_status,payment_date,application_fee,' +
          'property_id,property_address,' +
          'first_name,last_name,email,phone,dob,' +
          'requested_move_in_date,desired_lease_term,' +
          'employment_status,employer,job_title,monthly_income,' +
          'has_bankruptcy,has_criminal_history,' +
          'has_pets,pet_details,total_occupants,smoker,' +
          'has_co_applicant,admin_notes,' +
          'lease_status,lease_start_date,lease_end_date,monthly_rent,' +
          'move_in_status,move_in_date_actual'
        )
        .eq('landlord_id', landlordId)
        .order('created_at', { ascending: false });
      return _ok(data || [], error);
    },

    async getLandlordApplicationsByProperty(propertyIds) {
      if (!propertyIds || !propertyIds.length) return _ok([], null);
      const { data, error } = await sb()
        .from('applications')
        .select(
          'id,app_id,created_at,updated_at,status,payment_status,payment_date,application_fee,' +
          'property_id,property_address,' +
          'first_name,last_name,email,phone,' +
          'requested_move_in_date,desired_lease_term,' +
          'employment_status,employer,job_title,monthly_income,' +
          'has_bankruptcy,has_criminal_history,' +
          'has_pets,pet_details,total_occupants,smoker,' +
          'has_co_applicant,admin_notes,' +
          'lease_status,monthly_rent,move_in_status'
        )
        .in('property_id', propertyIds)
        .order('created_at', { ascending: false });
      return _ok(data || [], error);
    },

    async saveNotes(id, adminNotes) {
      const { data, error } = await sb().from('applications').update({ admin_notes: adminNotes, updated_at: new Date().toISOString() }).eq('id', id).select('id,admin_notes').single();
      return _ok(data, error);
    },

    async updateMoveIn(id, moveInStatus, moveInDateActual, moveInNotes) {
      const patch = { move_in_status: moveInStatus, updated_at: new Date().toISOString() };
      if (moveInDateActual) patch.move_in_date_actual = moveInDateActual;
      if (moveInNotes !== undefined) patch.move_in_notes = moveInNotes;
      const { data, error } = await sb().from('applications').update(patch).eq('id', id).select('id,move_in_status,move_in_date_actual,move_in_notes').single();
      return _ok(data, error);
    },

    async sendMessage(appId, message, sender = 'admin', senderName = 'Choice Properties') {
      return callEdgeFunction('send-message', {
        app_id: appId,
        message,
        sender,
        sender_name: senderName,
      });
    },

    async getCounts() {
      const { data, error } = await sb().from('applications').select('status,lease_status,move_in_status,payment_status,created_at');
      if (error) return _ok(null, error);
      const now = new Date();
      const som = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const rows = data || [];
      return _ok({
        total:            rows.length,
        pending:          rows.filter(r => r.status === 'pending').length,
        approved:         rows.filter(r => r.status === 'approved').length,
        denied:           rows.filter(r => r.status === 'denied').length,
        waitlisted:       rows.filter(r => r.status === 'waitlisted').length,
        this_month:       rows.filter(r => r.created_at >= som).length,
        lease_pending:    rows.filter(r => !r.lease_status || r.lease_status === 'none').length,
        lease_sent:       rows.filter(r => r.lease_status === 'sent').length,
        lease_signed:     rows.filter(r => r.lease_status === 'signed').length,
        movein_pending:   rows.filter(r => r.move_in_status === 'pending').length,
        movein_confirmed: rows.filter(r => r.move_in_status === 'confirmed').length,
        unpaid_approved:  rows.filter(r => r.payment_status === 'unpaid' && r.status === 'approved').length,
      }, null);
    },
  };
  
window.CP_esc = esc;
// IMPORTANT: merge — do not replace.
// cp-ui.js (loaded as a classic defer script before this module) installs
// window.CP.UI with the public-page helpers (esc, propertyUrl, fmtDate,
// safeAvatar, showToast, setupScrollTop, badge, …). Replacing window.CP
// here would wipe those out, leaving `CP.UI.esc` undefined on
// /property.html and crashing renderProperty the moment it tries to
// HTML-escape the address — which is exactly the "Some details could not
// be displayed. Please refresh." regression we just chased.
//
// So:
//   1. Merge top-level CP entries (services, helpers) onto whatever
//      cp-ui.js already put there.
//   2. Merge cp-api.js's UI methods (lqipUrl, statusBadge, paymentBadge,
//      cpConfirm, fmt, …) into the existing CP.UI object so the public
//      helpers (esc, propertyUrl, …) stay alive.
window.CP = Object.assign(window.CP || {}, {
  Applications, sb, Auth, Properties, SavedProperties, Inquiries, Landlords, EmailLogs,
  buildApplyURL, incrementCounter,
  getSession, getLandlordProfile, requireAuth,
  signIn, signUp, signOut, resetPassword, updateNav,
});
window.CP.UI = Object.assign(window.CP.UI || {}, UI);

// -- ES Module exports -------------------------------------
// Landlord pages and property.html import these by name.
// Each export delegates to the function defined above - no
// duplicated logic, no separate window.* assignments needed.
let _supabaseExport = null;
try { _supabaseExport = sb(); } catch (_) { /* CONFIG/SDK not ready at module init; use CP.sb() for lazy init */ }
export { _supabaseExport as supabase };
export { SavedProperties, buildApplyURL, incrementCounter, getSession, getLandlordProfile, requireAuth, signIn, signUp, signOut, resetPassword, updateNav };
