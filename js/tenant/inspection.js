'use strict';

// ─────────────────────────────────────────────────────────────────────
// tenant/inspection.js — Phase 08 chunk 3/N
//
// Mobile-first guided wizard for tenants to record a move-in / mid-term
// / move-out condition report.
//
// Flow:
//   Step 1: Pick inspection type. If a row already exists for this app
//           + type, hydrate the wizard with it (continue from save).
//   Step 2: Walk through each room. Per-item: condition (good / fair /
//           poor / damaged), notes, up to 4 photos. Photos uploaded
//           direct to the lease-inspection-photos bucket via the user's
//           own JWT (RLS policy enforces ownership by app_id path).
//           HEIC inputs converted via heic2any. Non-HEIC images
//           resized to <=1600px on longest edge and re-encoded as JPEG
//           q=0.85 to land under the brief's 500 KB target.
//           A best-effort EXIF parse pulls DateTimeOriginal off the
//           original file before canvas-stripping it; the timestamp is
//           sent to the edge function as taken_at_exif.
//   Step 3: General notes + canvas signature.
//   Step 4: Review summary; submit posts the full payload to the
//           record-inspection edge function which returns a versioned
//           PDF reference.
//
// State is held in a single module-level `state` object. `state.rooms`
// is the JSONB shape persisted on lease_inspections. Photos accumulate
// in `state.photos` (flat list with storage_path + room/item refs).
// ─────────────────────────────────────────────────────────────────────

// ── Config + helpers ─────────────────────────────────────────────────

const PHOTO_BUCKET = 'lease-inspection-photos';
const PHOTO_MAX_EDGE = 1600;     // px
const PHOTO_QUALITY  = 0.85;
const MAX_PHOTOS_PER_ITEM = 4;
const MAX_PHOTOS_TOTAL = 200;

const VALID_CONDITIONS = ['good', 'fair', 'poor', 'damaged'];

// Standard room scaffolding. Each entry → default items.
const STANDARD_ROOMS = [
  { key: 'living_room', label: 'Living Room', items: ['Walls', 'Ceiling', 'Floor', 'Windows', 'Blinds', 'Lights', 'Outlets'] },
  { key: 'kitchen',     label: 'Kitchen',     items: ['Stove / Range', 'Refrigerator', 'Dishwasher', 'Sink & Faucet', 'Cabinets', 'Countertops', 'Walls', 'Floor'] },
  { key: 'dining_room', label: 'Dining Room', items: ['Walls', 'Floor', 'Ceiling', 'Light Fixture'] },
  { key: 'bedroom_1',   label: 'Bedroom 1',   items: ['Walls', 'Floor', 'Ceiling', 'Windows', 'Closet', 'Lights', 'Outlets'] },
  { key: 'bedroom_2',   label: 'Bedroom 2',   items: ['Walls', 'Floor', 'Ceiling', 'Windows', 'Closet', 'Lights', 'Outlets'] },
  { key: 'bathroom_1',  label: 'Bathroom 1',  items: ['Toilet', 'Sink', 'Shower / Tub', 'Mirror', 'Walls', 'Floor', 'Exhaust Fan', 'Lights'] },
  { key: 'laundry',     label: 'Laundry',     items: ['Washer Hookup', 'Dryer Hookup', 'Walls', 'Floor'] },
  { key: 'exterior',    label: 'Exterior',    items: ['Yard', 'Walkway', 'Exterior Walls', 'Roof View', 'Parking'] },
];

// Default rooms preselected (the rest can be added via "+ Add Room")
const DEFAULT_ENABLED_ROOMS = ['living_room', 'kitchen', 'bedroom_1', 'bathroom_1', 'exterior'];

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(msg, kind) {
  if (window.CP && CP.UI && typeof CP.UI.toast === 'function') return CP.UI.toast(msg, kind || 'info');
  console.log('[' + (kind || 'info') + ']', msg);
}

async function waitForSB(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (window.supabase && typeof CONFIG !== 'undefined' && CONFIG.SUPABASE_URL) return true;
    await new Promise(r => setTimeout(r, 80));
  }
  return false;
}

let _sb = null;
function getSB() {
  if (!_sb) {
    _sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce' },
    });
    _sb.auth.onAuthStateChange(() => {});
  }
  return _sb;
}

// ── EXIF DateTimeOriginal extractor (best-effort, JPEG only) ─────────
// Returns ISO string or null. Walks APP1 / TIFF / IFD0 / ExifIFD to
// find tag 0x9003 ("DateTimeOriginal"). Handles both endians. Reads
// only the first 64 KB of the file.
async function extractExifDateTimeOriginal(file) {
  if (!file || !file.type || !/jpeg|jpg/i.test(file.type)) return null;
  try {
    const head = await file.slice(0, 65536).arrayBuffer();
    const view = new DataView(head);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;

    let off = 2;
    while (off + 4 < view.byteLength) {
      if (view.getUint8(off) !== 0xFF) return null;
      const marker = view.getUint8(off + 1);
      const segLen = view.getUint16(off + 2);
      if (marker === 0xE1) { // APP1 / EXIF
        const startEXIF = off + 4;
        if (view.getUint32(startEXIF) !== 0x45786966) return null; // 'Exif'
        const tiffStart = startEXIF + 6;
        const endian = view.getUint16(tiffStart);
        const little = endian === 0x4949;
        const u16 = (o) => little ? view.getUint16(o, true) : view.getUint16(o, false);
        const u32 = (o) => little ? view.getUint32(o, true) : view.getUint32(o, false);
        const ifd0Off = tiffStart + u32(tiffStart + 4);
        const ifd0Cnt = u16(ifd0Off);
        let exifIfdPtr = 0;
        for (let i = 0; i < ifd0Cnt; i++) {
          const e = ifd0Off + 2 + i * 12;
          const tag = u16(e);
          if (tag === 0x8769) { exifIfdPtr = tiffStart + u32(e + 8); break; }
        }
        if (!exifIfdPtr) return null;
        const exifCnt = u16(exifIfdPtr);
        for (let i = 0; i < exifCnt; i++) {
          const e = exifIfdPtr + 2 + i * 12;
          const tag = u16(e);
          if (tag === 0x9003) { // DateTimeOriginal: ASCII, count=20, ptr in last 4 bytes
            const cnt = u32(e + 4);
            const ptr = tiffStart + u32(e + 8);
            const bytes = new Uint8Array(view.buffer, ptr, Math.min(cnt, 20));
            let str = '';
            for (let j = 0; j < bytes.length; j++) {
              const c = bytes[j];
              if (c === 0) break;
              str += String.fromCharCode(c);
            }
            // "YYYY:MM:DD HH:MM:SS" → ISO
            const m = str.match(/^(\d{4}):(\d{2}):(\d{2})\s(\d{2}):(\d{2}):(\d{2})$/);
            if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
            return null;
          }
        }
        return null;
      }
      if (marker === 0xDA) return null; // start of scan — bail
      off += 2 + segLen;
    }
  } catch (_) { /* swallow */ }
  return null;
}

// ── HEIC + canvas resize → JPEG ──────────────────────────────────────
async function convertHeicIfNeeded(file) {
  const isHeic = /^image\/(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  if (!isHeic) return file;
  if (typeof window.heic2any !== 'function') {
    throw new Error('iPhone photo (HEIC) converter is still loading. Please wait a moment and try selecting your photo again.');
  }
  const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(out) ? out[0] : out;
  const newName = file.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
  return new File([blob], newName, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
}

async function resizeToJpeg(file) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('decode failed'));
    i.src = dataUrl;
  });
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const scale    = Math.min(1, PHOTO_MAX_EDGE / longEdge);
  const w        = Math.max(1, Math.round(img.naturalWidth  * scale));
  const h        = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas   = document.createElement('canvas');
  canvas.width   = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', PHOTO_QUALITY));
  return { blob, width: w, height: h };
}

// ── State ────────────────────────────────────────────────────────────

const state = {
  step:           1,
  app:            null,        // { id (uuid), app_id (text alias), property_address, ... }
  inspection_type: null,        // 'move_in' | 'mid_term' | 'move_out'
  existing_id:    null,        // server inspection id if continuing
  rooms:          {},          // { room_key: { items: [{name, condition, notes, photo_paths}] } }
  enabledRooms:   [],          // ordered list of room keys
  activeRoom:     null,
  photos:         [],          // [{ id, room_key, item_index, storage_path, status, error, taken_at_exif, byte_size, width, height, thumbDataUrl }]
  notes:          '',
  signaturePngDataUrl: null,
  submitting:     false,
};

function newItem(name) {
  return { name: name || 'Item', condition: null, notes: '', photo_ids: [] };
}

function buildDefaultRooms() {
  state.rooms = {};
  state.enabledRooms = [];
  for (const r of STANDARD_ROOMS) {
    if (DEFAULT_ENABLED_ROOMS.includes(r.key)) {
      state.rooms[r.key] = { items: r.items.map(n => newItem(n)) };
      state.enabledRooms.push(r.key);
    }
  }
  state.activeRoom = state.enabledRooms[0] || null;
}

// ── Auth + bootstrap ─────────────────────────────────────────────────

async function bootstrap() {
  if (!await waitForSB(8000)) {
    showError('Could not load — please refresh.');
    return;
  }
  const sb = getSB();
  const { data: sess } = await sb.auth.getSession();
  if (!sess?.session?.user) {
    location.href = '/tenant/login.html?next=' + encodeURIComponent(location.pathname + location.search);
    return;
  }
  const userEmail = (sess.session.user.email || '').toLowerCase();

  // Resolve app_id: either ?app=<uuid> or autoload the user's most recent app.
  const params = new URLSearchParams(location.search);
  const explicitApp = params.get('app');
  let appQ = sb.from('applications').select('id, app_id, property_address, first_name, last_name, email, status').limit(1);
  if (explicitApp) {
    appQ = appQ.eq('id', explicitApp);
  } else {
    appQ = appQ.ilike('email', userEmail).order('created_at', { ascending: false });
  }
  const { data: appRows, error: appErr } = await appQ;
  if (appErr || !appRows || !appRows.length) {
    showNotAuthorized();
    return;
  }
  const app = appRows[0];
  if ((app.email || '').toLowerCase() !== userEmail) {
    // RLS would block edits anyway, but fail fast with a clear message.
    showNotAuthorized();
    return;
  }
  state.app = app;
  $('#hero-addr').textContent = app.property_address || '';
  if (app.first_name) $('#hero-title').textContent = `Inspection — ${app.first_name}'s rental`;

  $('#loading').hidden = true;
  $('#content').hidden = false;
  $('#nav-footer').hidden = false;

  wireUi();
  // Pre-select type from URL (?type=move_in) if provided
  const t = (params.get('type') || '').toLowerCase();
  if (['move_in', 'mid_term', 'move_out'].includes(t)) {
    pickType(t);
  } else {
    renderStep();
  }
}

function showError(msg) {
  $('#loading').innerHTML = `<div class="alert alert-err" style="text-align:left">${esc(msg)}</div>`;
}
function showNotAuthorized() {
  $('#loading').hidden = true;
  $('#not-authorized').hidden = false;
}

// ── Type selection ───────────────────────────────────────────────────

async function pickType(type) {
  state.inspection_type = type;
  $$('#step-1 .type-tile').forEach(t => {
    const on = t.dataset.type === type;
    t.setAttribute('aria-checked', String(on));
    t.setAttribute('aria-pressed', String(on));
  });

  // Try to load existing inspection for this app + type so user can resume.
  $('#step1-existing').style.display = 'none';
  try {
    const { data: rows } = await getSB().from('lease_inspections')
      .select('id, rooms, notes, tenant_sig_image, tenant_signed_at, completed_at, photos_count')
      .eq('app_id', state.app.id).eq('inspection_type', type)
      .order('updated_at', { ascending: false }).limit(1);
    const existing = rows && rows[0];
    if (existing) {
      state.existing_id = existing.id;
      // Hydrate
      try {
        if (existing.rooms && typeof existing.rooms === 'object') {
          state.rooms = JSON.parse(JSON.stringify(existing.rooms));
          state.enabledRooms = Object.keys(state.rooms);
          state.activeRoom = state.enabledRooms[0] || null;
        } else {
          buildDefaultRooms();
        }
      } catch { buildDefaultRooms(); }
      state.notes               = existing.notes || '';
      state.signaturePngDataUrl = existing.tenant_sig_image || null;

      const isComplete = !!existing.completed_at;
      const pic = existing.photos_count ? ` (${existing.photos_count} photos on file)` : '';
      $('#step1-existing').style.display = '';
      $('#step1-existing').innerHTML = isComplete
        ? `You already completed this ${labelForType(type)} report${esc(pic)}. Continuing will <strong>replace</strong> the existing report.`
        : `You have a draft for this ${labelForType(type)} report${esc(pic)}. Your work will be loaded in.`;
    } else {
      state.existing_id = null;
      buildDefaultRooms();
    }
  } catch (_) {
    state.existing_id = null;
    buildDefaultRooms();
  }
  renderStep();
}

function labelForType(t) {
  return t === 'move_in' ? 'move-in' : t === 'move_out' ? 'move-out' : 'mid-term';
}

// ── Wiring (one-time) ────────────────────────────────────────────────

function wireUi() {
  $$('#step-1 .type-tile').forEach(tile => {
    tile.addEventListener('click', () => pickType(tile.dataset.type));
  });
  $('#btn-next').addEventListener('click', onNext);
  $('#btn-prev').addEventListener('click', onPrev);
  $('#btn-add-room').addEventListener('click', onAddRoom);
  $('#btn-remove-room').addEventListener('click', onRemoveRoom);
  $('#btn-add-item').addEventListener('click', () => {
    if (!state.activeRoom) return;
    state.rooms[state.activeRoom].items.push(newItem('Custom item'));
    renderRoom();
  });
  $('#general-notes').addEventListener('input', e => { state.notes = e.target.value; });
}

// ── Step rendering ──────────────────────────────────────────────────

function renderStep() {
  for (let i = 1; i <= 4; i++) {
    const card = $('#step-' + i);
    if (card) card.hidden = (i !== state.step);
    const pill = document.querySelector(`.step-pill[data-step="${i}"]`);
    if (pill) {
      pill.removeAttribute('data-active');
      pill.removeAttribute('data-done');
      if (i === state.step) pill.setAttribute('data-active', '');
      else if (i < state.step) pill.setAttribute('data-done', '');
    }
  }
  $('#btn-prev').hidden = state.step === 1;
  if (state.step === 4) {
    $('#btn-next').textContent = state.submitting ? 'Submitting…' : 'Submit Inspection';
  } else {
    $('#btn-next').textContent = 'Next →';
  }
  refreshNextEnabled();

  if (state.step === 2) renderRoomTabs(), renderRoom();
  if (state.step === 3) initSignaturePad();
  if (state.step === 4) renderReview();
}

function refreshNextEnabled() {
  let ok = false;
  if (state.step === 1) ok = !!state.inspection_type;
  if (state.step === 2) ok = state.enabledRooms.length > 0;
  if (state.step === 3) ok = !!state.signaturePngDataUrl;
  if (state.step === 4) ok = !state.submitting;
  $('#btn-next').disabled = !ok;
}

function onNext() {
  if (state.step < 4) { state.step += 1; renderStep(); return; }
  if (state.step === 4) submitInspection();
}
function onPrev() {
  if (state.step > 1) { state.step -= 1; renderStep(); }
}

// ── Step 2 — rooms + items ───────────────────────────────────────────

function renderRoomTabs() {
  const host = $('#room-tabs');
  host.innerHTML = '';
  for (const key of state.enabledRooms) {
    const room = state.rooms[key];
    const itemsWithCondition = (room.items || []).filter(it => it.condition).length;
    const total = (room.items || []).length;
    const done  = total > 0 && itemsWithCondition === total;
    const btn = document.createElement('button');
    btn.className = 'room-tab';
    btn.type = 'button';
    btn.textContent = labelForRoom(key) + (total ? ` (${itemsWithCondition}/${total})` : '');
    if (key === state.activeRoom) btn.setAttribute('data-state', 'active');
    else if (done)                 btn.setAttribute('data-state', 'done');
    btn.addEventListener('click', () => { state.activeRoom = key; renderRoomTabs(); renderRoom(); });
    host.appendChild(btn);
  }
}

function labelForRoom(key) {
  const std = STANDARD_ROOMS.find(r => r.key === key);
  if (std) return std.label;
  return key.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
}

function renderRoom() {
  const host = $('#items-host');
  host.innerHTML = '';
  $('#active-room-name').textContent = state.activeRoom ? labelForRoom(state.activeRoom) : '—';
  if (!state.activeRoom) return;
  const room = state.rooms[state.activeRoom];
  if (!room) return;

  room.items.forEach((item, idx) => host.appendChild(renderItemCard(state.activeRoom, idx, item)));
  refreshNextEnabled();
}

function renderItemCard(roomKey, itemIdx, item) {
  const wrap = document.createElement('div');
  wrap.className = 'item';

  // Head: editable name + remove button
  const head = document.createElement('div');
  head.className = 'item-head';
  const nameInput = document.createElement('input');
  nameInput.className = 'item-name';
  nameInput.value = item.name || '';
  nameInput.addEventListener('input', e => { item.name = e.target.value; });
  head.appendChild(nameInput);

  const rmBtn = document.createElement('button');
  rmBtn.className = 'item-remove';
  rmBtn.type = 'button';
  rmBtn.textContent = 'Remove';
  rmBtn.addEventListener('click', () => {
    state.rooms[roomKey].items.splice(itemIdx, 1);
    // Drop dangling photos for this item
    state.photos = state.photos.filter(p => !(p.room_key === roomKey && p.item_index === itemIdx));
    // Reindex photos for items after this one
    state.photos.forEach(p => {
      if (p.room_key === roomKey && p.item_index > itemIdx) p.item_index -= 1;
    });
    renderRoom(); renderRoomTabs();
  });
  head.appendChild(rmBtn);
  wrap.appendChild(head);

  // Condition pills
  const condRow = document.createElement('div');
  condRow.className = 'cond-row';
  for (const c of VALID_CONDITIONS) {
    const b = document.createElement('button');
    b.className = 'cond-btn';
    b.dataset.c = c;
    b.type = 'button';
    b.textContent = c.charAt(0).toUpperCase() + c.slice(1);
    b.setAttribute('aria-pressed', String(item.condition === c));
    b.addEventListener('click', () => {
      item.condition = (item.condition === c ? null : c);
      renderRoom(); renderRoomTabs();
    });
    condRow.appendChild(b);
  }
  wrap.appendChild(condRow);

  // Notes
  const notes = document.createElement('textarea');
  notes.className = 'item-notes';
  notes.rows = 1;
  notes.placeholder = 'Notes (optional, e.g. "small scuff near door").';
  notes.value = item.notes || '';
  notes.addEventListener('input', e => { item.notes = e.target.value; });
  wrap.appendChild(notes);

  // Photos
  const gallery = document.createElement('div');
  gallery.className = 'photos';
  const myPhotos = state.photos.filter(p => p.room_key === roomKey && p.item_index === itemIdx);
  for (const p of myPhotos) gallery.appendChild(renderPhotoTile(p));
  if (myPhotos.length < MAX_PHOTOS_PER_ITEM) gallery.appendChild(renderAddTile(roomKey, itemIdx));
  wrap.appendChild(gallery);

  return wrap;
}

function renderPhotoTile(p) {
  const div = document.createElement('div');
  div.className = 'photo';
  div.dataset.state = p.status;
  if (p.thumbDataUrl) {
    const img = document.createElement('img');
    img.src = p.thumbDataUrl;
    img.alt = '';
    div.appendChild(img);
  }
  const rm = document.createElement('button');
  rm.className = 'rm';
  rm.type = 'button';
  rm.textContent = '×';
  rm.title = 'Remove';
  rm.addEventListener('click', async () => {
    if (p.status === 'uploaded' && p.storage_path) {
      try { await getSB().storage.from(PHOTO_BUCKET).remove([p.storage_path]); } catch (_) {}
    }
    state.photos = state.photos.filter(x => x.id !== p.id);
    renderRoom();
  });
  div.appendChild(rm);
  if (p.status !== 'uploaded') {
    const badge = document.createElement('div');
    badge.className = 'badge';
    if (p.status === 'failed') {
      // Show the specific error message (e.g. HEIC converter not ready) so the user
      // sees actionable text right on the tile — not just in the temporary toast.
      const errText = p.error || 'Upload failed — tap to retry';
      badge.textContent = errText;
      badge.title = errText;
    } else {
      badge.textContent = p.status === 'uploading' ? 'Uploading…' : 'Pending';
    }
    div.appendChild(badge);
    if (p.status === 'failed') {
      div.style.cursor = 'pointer';
      div.addEventListener('click', () => uploadOne(p));
    }
  }
  return div;
}

function renderAddTile(roomKey, itemIdx) {
  const div = document.createElement('div');
  div.className = 'photo';
  const btn = document.createElement('label');
  btn.className = 'add';
  btn.textContent = '+';
  btn.title = 'Add photo';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.heic,.heif';
  // Do NOT set input.capture — on Android it would open the camera only and
  // prevent the tenant from picking an existing photo from their gallery.
  // The accept filter above is sufficient; the browser's native picker offers
  // both camera and library options without the capture attribute.
  input.multiple = false;
  input.style.display = 'none';
  input.addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (state.photos.length >= MAX_PHOTOS_TOTAL) {
      toast(`Maximum ${MAX_PHOTOS_TOTAL} photos per inspection.`, 'warn');
      return;
    }
    await handleNewPhoto(file, roomKey, itemIdx);
  });
  btn.appendChild(input);
  div.appendChild(btn);
  return div;
}

async function handleNewPhoto(file, roomKey, itemIdx) {
  const placeholder = {
    id: cryptoRandomId(),
    room_key: roomKey,
    item_index: itemIdx,
    storage_path: null,
    status: 'pending',
    error: null,
    taken_at_exif: null,
    byte_size: null,
    width: null,
    height: null,
    thumbDataUrl: null,
  };
  state.photos.push(placeholder);
  renderRoom();

  try {
    const exifIso = await extractExifDateTimeOriginal(file);
    placeholder.taken_at_exif = exifIso;

    placeholder.status = 'processing';
    renderRoom();
    const converted = await convertHeicIfNeeded(file);
    const { blob, width, height } = await resizeToJpeg(converted);
    placeholder.width = width; placeholder.height = height; placeholder.byte_size = blob.size;
    placeholder.thumbDataUrl = await blobToDataUrl(blob);
    renderRoom();

    placeholder._uploadBlob = blob;
    await uploadOne(placeholder);
  } catch (e) {
    placeholder.status = 'failed';
    placeholder.error = (e && e.message) || 'Photo failed';
    renderRoom();
    toast(placeholder.error, 'warn');
  }
}

async function uploadOne(p) {
  if (!p._uploadBlob && !p.storage_path) {
    p.status = 'failed';
    p.error = 'No image data';
    renderRoom();
    return;
  }
  p.status = 'uploading';
  renderRoom();
  try {
    const path = p.storage_path || (
      `${state.app.id}/${state.inspection_type}/${cryptoRandomId()}.jpg`
    );
    const { error } = await getSB().storage.from(PHOTO_BUCKET)
      .upload(path, p._uploadBlob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw new Error(error.message || 'Upload failed');
    p.storage_path = path;
    p.status = 'uploaded';
    p.error = null;
    renderRoom();
  } catch (e) {
    p.status = 'failed';
    p.error = (e && e.message) || 'Upload failed';
    renderRoom();
  }
}

async function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('read failed'));
    r.readAsDataURL(blob);
  });
}
function cryptoRandomId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Date.now() + '_' + Math.random().toString(16).slice(2);
}

// ── Add / remove room ────────────────────────────────────────────────

function onAddRoom() {
  // Build a picker of un-enabled standard rooms + custom
  const candidates = STANDARD_ROOMS.filter(r => !state.enabledRooms.includes(r.key));
  const choices = candidates.map(r => r.label).concat(['Custom room…']);
  const pick = window.prompt('Add a room:\n\n' + choices.map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n\nEnter the number:');
  if (!pick) return;
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= choices.length) return;

  if (idx === choices.length - 1) {
    const name = window.prompt('Custom room name (e.g. "Office", "Garage"):');
    if (!name) return;
    const key = (name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'custom').slice(0, 40);
    if (state.rooms[key]) { toast('A room with that name already exists.', 'warn'); return; }
    state.rooms[key] = { items: [newItem('Walls'), newItem('Floor'), newItem('Ceiling')] };
    state.enabledRooms.push(key);
    state.activeRoom = key;
  } else {
    const r = candidates[idx];
    state.rooms[r.key] = { items: r.items.map(n => newItem(n)) };
    state.enabledRooms.push(r.key);
    state.activeRoom = r.key;
  }
  renderRoomTabs(); renderRoom();
}

function onRemoveRoom() {
  if (!state.activeRoom) return;
  if (state.enabledRooms.length <= 1) { toast('At least one room is required.', 'warn'); return; }
  if (!window.confirm(`Remove "${labelForRoom(state.activeRoom)}" and all its items?`)) return;
  const key = state.activeRoom;
  delete state.rooms[key];
  state.enabledRooms = state.enabledRooms.filter(k => k !== key);
  state.photos = state.photos.filter(p => p.room_key !== key);
  state.activeRoom = state.enabledRooms[0] || null;
  renderRoomTabs(); renderRoom();
}

// ── Step 3 — signature pad ───────────────────────────────────────────

let _padInited = false;
function initSignaturePad() {
  const canvas = $('#sig-canvas');
  const ctx = canvas.getContext('2d');
  let drawing = false, hasInk = !!state.signaturePngDataUrl, lastX = 0, lastY = 0;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.width  = Math.round(rect.width  * ratio);
    canvas.height = Math.round(rect.height * ratio);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1e293b';
  }
  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const t = (e.touches && e.touches[0]) || e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  function start(e) { e.preventDefault(); drawing = true; const p = pos(e); lastX = p.x; lastY = p.y; }
  function move(e)  { if (!drawing) return; e.preventDefault(); const p = pos(e); ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke(); lastX = p.x; lastY = p.y; if (!hasInk) hasInk = true; commit(); }
  function end(e)   { if (e && e.preventDefault) e.preventDefault(); drawing = false; commit(); }
  function commit() {
    state.signaturePngDataUrl = hasInk ? canvas.toDataURL('image/png') : null;
    refreshNextEnabled();
  }

  if (!_padInited) {
    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove',  move,  { passive: false });
    canvas.addEventListener('touchend',   end);
    $('#sig-clear').addEventListener('click', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasInk = false; state.signaturePngDataUrl = null; refreshNextEnabled();
    });
    window.addEventListener('resize', resize);
    _padInited = true;
  }
  // Always re-fit the canvas when the step is shown (it was display:none).
  // Always restore saved signature data regardless of local hasInk state —
  // hasInk is initialised from state.signaturePngDataUrl which means it is
  // already true when a signature exists, so the old `&& !hasInk` guard
  // prevented the restore from ever running on return visits to this step.
  setTimeout(() => {
    resize();
    if (state.signaturePngDataUrl) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height); hasInk = true; };
      img.src = state.signaturePngDataUrl;
    }
  }, 40);

  $('#general-notes').value = state.notes || '';
}

// ── Step 4 — review + submit ─────────────────────────────────────────

function renderReview() {
  const host = $('#review-host');
  host.innerHTML = '';
  for (const key of state.enabledRooms) {
    const room = state.rooms[key];
    const card = document.createElement('div');
    card.className = 'review-room';
    let html = `<h4>${esc(labelForRoom(key))}</h4>`;
    for (const item of (room.items || [])) {
      const cond = item.condition || 'none';
      const dotCls = 'dot-' + (item.condition || 'none');
      const photoCount = state.photos.filter(p => p.room_key === key && p.item_index === room.items.indexOf(item)).length;
      const photoStr = photoCount > 0 ? ` · ${photoCount} photo${photoCount === 1 ? '' : 's'}` : '';
      html += `<div class="review-item"><span class="dot ${dotCls}"></span>${esc(item.name)} — <strong>${esc(cond)}</strong>${esc(item.notes ? ' (' + item.notes + ')' : '')}${photoStr}</div>`;
    }
    card.innerHTML = html;
    host.appendChild(card);
  }
  if (state.notes) {
    const card = document.createElement('div');
    card.className = 'review-room';
    card.innerHTML = `<h4>General notes</h4><div class="review-item">${esc(state.notes)}</div>`;
    host.appendChild(card);
  }
}

async function submitInspection() {
  $('#submit-error').style.display = 'none';
  $('#submit-ok').style.display = 'none';

  // Wait for any in-flight uploads
  const pending = state.photos.filter(p => p.status === 'uploading' || p.status === 'pending' || p.status === 'processing');
  if (pending.length) {
    showSubmitError(`${pending.length} photo${pending.length === 1 ? '' : 's'} still uploading. Wait a moment and try again.`);
    return;
  }
  const failed = state.photos.filter(p => p.status === 'failed');
  if (failed.length) {
    showSubmitError(`${failed.length} photo upload${failed.length === 1 ? '' : 's'} failed. Tap each red tile to retry, or remove them, then submit again.`);
    return;
  }

  // Build payload
  const roomsPayload = {};
  for (const key of state.enabledRooms) {
    const room = state.rooms[key];
    roomsPayload[key] = {
      items: (room.items || []).map((it, idx) => {
        const photo_paths = state.photos
          .filter(p => p.room_key === key && p.item_index === idx && p.storage_path)
          .map(p => p.storage_path);
        const out = { name: it.name || 'Item' };
        if (it.condition) out.condition = it.condition;
        if (it.notes)      out.notes      = it.notes;
        if (photo_paths.length) out.photo_paths = photo_paths;
        return out;
      }),
    };
  }
  const photosPayload = state.photos
    .filter(p => p.storage_path)
    .map(p => ({
      storage_path:  p.storage_path,
      room_key:      p.room_key,
      item_key:      (state.rooms[p.room_key]?.items?.[p.item_index]?.name || null),
      taken_at_exif: p.taken_at_exif,
      byte_size:     p.byte_size,
      width:         p.width,
      height:        p.height,
    }));

  const body = {
    app_id:             state.app.id,
    inspection_type:    state.inspection_type,
    completed_at:       new Date().toISOString(),
    completed_by_role:  'tenant',
    rooms:              roomsPayload,
    notes:              state.notes || null,
    tenant_sig_image:   state.signaturePngDataUrl,
    photos:             photosPayload,
  };

  state.submitting = true;
  $('#btn-next').disabled = true;
  $('#btn-next').textContent = 'Submitting…';

  try {
    const sb = getSB();
    const { data: sess } = await sb.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) throw new Error('Session expired — please sign in again.');

    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/record-inspection`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
        'apikey':        CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error || !json.success) {
      throw new Error(json.error || `Server returned ${res.status}`);
    }

    $('#submit-ok').style.display = '';
    $('#submit-ok').innerHTML = `Inspection submitted. A signed PDF has been added to your lease record.<br>` +
      `<small>Reference: ${esc(json.inspection_id || '')}</small>`;
    $('#btn-next').textContent = 'Submitted ✓';
    $('#btn-next').disabled = true;
    $('#btn-prev').hidden = true;
    state.submitting = false;
  } catch (e) {
    state.submitting = false;
    showSubmitError((e && e.message) || 'Submission failed.');
    $('#btn-next').textContent = 'Submit Inspection';
    refreshNextEnabled();
  }
}

function showSubmitError(msg) {
  $('#submit-error').style.display = '';
  $('#submit-error').textContent = msg;
}

// ── Boot ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => { bootstrap(); });
