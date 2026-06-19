'use strict';

// ─────────────────────────────────────────────────────────────────────
// landlord/inspection-review.js — Phase 08 chunk 4/N
//
// Landlord (or admin) review interface for tenant-submitted condition
// reports. Loads an existing inspection by ?id=<uuid> OR
// ?app=<uuid>&type=<move_in|mid_term|move_out>, renders tenant data
// read-only on the left of each item, lets the landlord set their own
// agreement (agree / dispute), notes, and counter-photos on the right.
// Submits via the same record-inspection edge function shipped in
// chunk 2/N — which auto-detects role from auth and stamps
// landlord_signed_at + landlord_sig_image.
// ─────────────────────────────────────────────────────────────────────

const PHOTO_BUCKET = 'lease-inspection-photos';
const PHOTO_MAX_EDGE = 1600;
const PHOTO_QUALITY  = 0.85;
const MAX_PHOTOS_PER_ITEM_LL = 4;

const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
function fmtDate(d){if(!d)return '—';try{return new Date(d).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});}catch{return d;}}
function fmtRoomKey(k){return k.replace(/_/g,' ').replace(/\b\w/g,m=>m.toUpperCase());}
function labelForType(t){return t==='move_in'?'Move-In':t==='move_out'?'Move-Out':'Mid-Term';}

async function waitForSB(ms){
  const end=Date.now()+ms;
  while(Date.now()<end){
    if(window.supabase&&typeof CONFIG!=='undefined'&&CONFIG.SUPABASE_URL)return true;
    await new Promise(r=>setTimeout(r,80));
  }
  return false;
}
let _sb=null;
function getSB(){
  if(!_sb){
    _sb=window.supabase.createClient(CONFIG.SUPABASE_URL,CONFIG.SUPABASE_ANON_KEY,{
      auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,flowType:'pkce'},
    });
    _sb.auth.onAuthStateChange(()=>{});
  }
  return _sb;
}

// ── State ────────────────────────────────────────────────────────────
const state = {
  inspection: null,        // server row
  app:        null,        // application row
  rooms:      {},          // mutable copy of inspection.rooms (writes landlord_* fields)
  landlordPhotos: [],      // [{id, room_key, item_key, storage_path, status, blob, thumbDataUrl, byte_size, width, height, taken_at_exif}]
  signaturePngDataUrl: null,
  submitting: false,
  signedUrlCache: new Map(),  // path -> { url, expiresAt }
};

// ── Bootstrap ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { bootstrap(); });

async function bootstrap(){
  if(!await waitForSB(8000)){
    showError('Could not load — please refresh.');
    return;
  }
  const sb = getSB();
  const { data: sess } = await sb.auth.getSession();
  if(!sess?.session?.user){
    location.href = '/landlord/login.html?next=' + encodeURIComponent(location.pathname + location.search);
    return;
  }

  const params = new URLSearchParams(location.search);
  const idParam   = params.get('id');
  const appParam  = params.get('app');
  const typeParam = (params.get('type') || '').toLowerCase();

  let q = sb.from('lease_inspections')
    .select('id, app_id, inspection_type, rooms, notes, photos_count, completed_at, completed_by_role, tenant_sig_image, tenant_signed_at, landlord_sig_image, landlord_signed_at, created_at, updated_at')
    .limit(1);
  if (idParam) q = q.eq('id', idParam);
  else if (appParam && typeParam) q = q.eq('app_id', appParam).eq('inspection_type', typeParam);
  else { showNotFound(); return; }

  const { data: inspRows, error: inspErr } = await q;
  if (inspErr || !inspRows || !inspRows.length) { showNotFound(); return; }
  state.inspection = inspRows[0];
  state.rooms = (state.inspection.rooms && typeof state.inspection.rooms === 'object')
    ? JSON.parse(JSON.stringify(state.inspection.rooms))
    : {};
  state.signaturePngDataUrl = state.inspection.landlord_sig_image || null;
  $('#landlord-notes').value = state.inspection.notes || '';

  // Pull the application for header context
  const { data: appRows } = await sb.from('applications')
    .select('id, app_id, first_name, last_name, email, property_address, city, state, status')
    .eq('id', state.inspection.app_id).limit(1);
  state.app = (appRows && appRows[0]) || null;

  $('#loading').hidden = true;
  $('#content').hidden = false;
  $('#actions').hidden = false;
  renderHeader();
  renderTenantSig();
  renderRooms();
  initSignaturePad();
  wireFooter();
  refreshSubmit();
}

function showError(msg){
  $('#loading').innerHTML = `<div class="alert alert-err" style="text-align:left">${esc(msg)}</div>`;
}
function showNotFound(){
  $('#loading').hidden = true;
  $('#not-found').hidden = false;
}

// ── Header + tenant sig ──────────────────────────────────────────────
function renderHeader(){
  const i = state.inspection;
  const a = state.app;
  $('#title').textContent = `${labelForType(i.inspection_type)} Inspection`;
  if (a) {
    $('#property-line').textContent = a.property_address || '';
    $('#tenant-line').textContent = `Tenant: ${(a.first_name||'')} ${(a.last_name||'')} · ${a.email||''}`;
  }
  const pills = [];
  pills.push(`<span class="pill pill-info">${esc(labelForType(i.inspection_type))}</span>`);
  if (i.tenant_signed_at)   pills.push(`<span class="pill pill-ok">Tenant signed ${esc(fmtDate(i.tenant_signed_at))}</span>`);
  else                       pills.push(`<span class="pill pill-warn">Awaiting tenant signature</span>`);
  if (i.landlord_signed_at) pills.push(`<span class="pill pill-ok">You signed ${esc(fmtDate(i.landlord_signed_at))}</span>`);
  else                       pills.push(`<span class="pill pill-warn">Your signature pending</span>`);
  if (i.photos_count != null) pills.push(`<span class="pill pill-muted">${i.photos_count} photo${i.photos_count===1?'':'s'} on file</span>`);
  $('#status-pills').innerHTML = pills.join('');
}

function renderTenantSig(){
  const i = state.inspection;
  const host = $('#tenant-sig-block');
  if (i.tenant_sig_image) {
    host.innerHTML = `
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <img src="${esc(i.tenant_sig_image)}" alt="Tenant signature">
        <div style="font-size:.82rem;color:var(--muted)">
          Signed: <strong style="color:var(--text)">${esc(fmtDate(i.tenant_signed_at))}</strong><br>
          Role on record: ${esc(i.completed_by_role || '—')}
        </div>
      </div>`;
  } else {
    host.innerHTML = `<em style="color:var(--muted);font-size:.84rem">No tenant signature on file yet.</em>`;
  }
}

// ── Rooms / items ────────────────────────────────────────────────────
function renderRooms(){
  const host = $('#rooms-host');
  host.innerHTML = '';
  const roomKeys = Object.keys(state.rooms);
  if (!roomKeys.length) {
    host.innerHTML = `<div class="alert alert-info">The tenant hasn't entered any room data yet.</div>`;
    return;
  }
  for (const key of roomKeys) {
    const room = state.rooms[key];
    const roomEl = document.createElement('div');
    roomEl.className = 'room';
    roomEl.appendChild(Object.assign(document.createElement('h3'), { textContent: fmtRoomKey(key) }));
    const items = (room.items || []);
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'item';
      e.innerHTML = `<em style="color:var(--muted);font-size:.82rem">No items recorded for this room.</em>`;
      roomEl.appendChild(e);
    } else {
      items.forEach((item, idx) => roomEl.appendChild(renderItem(key, idx, item)));
    }
    host.appendChild(roomEl);
  }
}

function renderItem(roomKey, idx, item){
  const wrap = document.createElement('div');
  wrap.className = 'item';
  const cond = (item.condition || 'none').toLowerCase();
  const tenantPhotos = Array.isArray(item.photo_paths) ? item.photo_paths : [];

  // Header
  const head = document.createElement('div');
  head.className = 'item-name';
  head.textContent = item.name || '—';
  wrap.appendChild(head);

  // Two-column layout
  const row = document.createElement('div'); row.className = 'row';

  // Tenant column (read-only)
  const tCol = document.createElement('div'); tCol.className = 'col'; tCol.dataset.side = 'tenant';
  tCol.innerHTML = `<h4>Tenant says</h4>
    <span class="cond-display cond-${esc(cond)}">${esc(cond)}</span>
    <div class="notes-display ${item.notes ? '' : 'empty'}">${item.notes ? esc(item.notes) : 'No notes'}</div>`;
  if (tenantPhotos.length){
    const g = document.createElement('div'); g.className = 'photos';
    tenantPhotos.forEach(path => g.appendChild(renderRemotePhoto(path, false)));
    tCol.appendChild(g);
  }
  row.appendChild(tCol);

  // Landlord column (editable)
  const lCol = document.createElement('div'); lCol.className = 'col'; lCol.dataset.side = 'landlord';
  lCol.innerHTML = `<h4>Your review</h4>`;

  // Agree / dispute pill row
  const agreeRow = document.createElement('div'); agreeRow.className = 'agree-row';
  const current = item.landlord_agreement || null;
  for (const v of ['agree', 'dispute']) {
    const b = document.createElement('button');
    b.className = 'agree-btn';
    b.dataset.v = v;
    b.type = 'button';
    b.textContent = v.charAt(0).toUpperCase() + v.slice(1);
    b.setAttribute('aria-pressed', String(current === v));
    b.addEventListener('click', () => {
      item.landlord_agreement = (item.landlord_agreement === v ? null : v);
      renderRooms();
    });
    agreeRow.appendChild(b);
  }
  lCol.appendChild(agreeRow);

  // Landlord notes
  const lordNotes = document.createElement('textarea');
  lordNotes.className = 'lord-notes';
  lordNotes.rows = 2;
  lordNotes.placeholder = 'Notes (optional, e.g. "billed to deposit", "agreed to repair").';
  lordNotes.value = item.landlord_notes || '';
  lordNotes.addEventListener('input', e => { item.landlord_notes = e.target.value; });
  lCol.appendChild(lordNotes);

  // Landlord photos
  const photosRoot = document.createElement('div'); photosRoot.className = 'photos';
  // Existing landlord photos already saved on the item
  const lordPhotoPaths = Array.isArray(item.landlord_photo_paths) ? item.landlord_photo_paths : [];
  lordPhotoPaths.forEach(path => photosRoot.appendChild(renderRemotePhoto(path, true, () => {
    item.landlord_photo_paths = lordPhotoPaths.filter(p => p !== path);
    renderRooms();
  })));
  // Pending uploads from this session
  const myPending = state.landlordPhotos.filter(p => p.room_key === roomKey && p.item_key === item.name);
  for (const p of myPending) photosRoot.appendChild(renderPendingPhoto(p, () => {
    state.landlordPhotos = state.landlordPhotos.filter(x => x.id !== p.id);
    renderRooms();
  }));
  const total = lordPhotoPaths.length + myPending.length;
  if (total < MAX_PHOTOS_PER_ITEM_LL) photosRoot.appendChild(renderAddTile(roomKey, item.name, idx));
  lCol.appendChild(photosRoot);

  row.appendChild(lCol);
  wrap.appendChild(row);
  return wrap;
}

// ── Photo tiles ──────────────────────────────────────────────────────
function renderRemotePhoto(path, allowRemove, onRemove){
  const div = document.createElement('div'); div.className = 'photo';
  const img = document.createElement('img'); img.alt = '';
  div.appendChild(img);
  resolveSignedUrl(path).then(u => { if (u) { img.src = u; img.addEventListener('click', () => openLightbox(u)); } });
  if (allowRemove) {
    const rm = document.createElement('button'); rm.className = 'rm'; rm.type = 'button'; rm.textContent = '×'; rm.title = 'Remove';
    rm.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm('Remove this photo?')) return;
      // Best-effort delete from storage; the inspection row is the source of truth so we also drop from the path list.
      getSB().storage.from(PHOTO_BUCKET).remove([path]).catch(()=>{});
      if (onRemove) onRemove();
    });
    div.appendChild(rm);
  }
  return div;
}

function renderPendingPhoto(p, onRemove){
  const div = document.createElement('div'); div.className = 'photo'; div.dataset.state = p.status;
  if (p.thumbDataUrl) {
    const img = document.createElement('img'); img.src = p.thumbDataUrl; div.appendChild(img);
  }
  const rm = document.createElement('button'); rm.className = 'rm'; rm.type = 'button'; rm.textContent = '×';
  rm.addEventListener('click', async () => {
    if (p.status === 'uploaded' && p.storage_path) {
      try { await getSB().storage.from(PHOTO_BUCKET).remove([p.storage_path]); } catch (_) {}
    }
    if (onRemove) onRemove();
  });
  div.appendChild(rm);
  if (p.status !== 'uploaded') {
    const badge = document.createElement('div'); badge.className = 'badge';
    badge.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.55);color:#fff;font-size:.66rem;padding:2px 4px;text-align:center';
    badge.textContent = p.status === 'failed' ? 'Failed — tap to retry' : (p.status === 'uploading' ? 'Uploading…' : 'Pending');
    div.appendChild(badge);
    if (p.status === 'failed') { div.style.cursor = 'pointer'; div.addEventListener('click', () => uploadOne(p)); }
  }
  return div;
}

function renderAddTile(roomKey, itemKey){
  const div = document.createElement('div'); div.className = 'photo';
  const btn = document.createElement('label'); btn.className = 'add'; btn.textContent = '+'; btn.title = 'Add photo';
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*,.heic,.heif'; input.style.display = 'none';
  input.addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    await handleNewPhoto(file, roomKey, itemKey);
  });
  btn.appendChild(input);
  div.appendChild(btn);
  return div;
}

async function resolveSignedUrl(path){
  if (!path) return null;
  const cached = state.signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.url;
  try {
    const { data, error } = await getSB().storage.from(PHOTO_BUCKET).createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) return null;
    state.signedUrlCache.set(path, { url: data.signedUrl, expiresAt: Date.now() + 3600_000 });
    return data.signedUrl;
  } catch { return null; }
}

function openLightbox(url){
  $('#lightbox-img').src = url;
  $('#lightbox').setAttribute('data-open', '');
}
document.addEventListener('click', e => {
  if (e.target.id === 'lightbox-close' || e.target.id === 'lightbox') {
    $('#lightbox').removeAttribute('data-open');
  }
});

// ── Photo pipeline (HEIC + resize + upload) ─────────────────────────
async function handleNewPhoto(file, roomKey, itemKey){
  const placeholder = {
    id: cryptoRandomId(),
    room_key: roomKey,
    item_key: itemKey,
    storage_path: null,
    status: 'pending',
    error: null,
    taken_at_exif: null,
    byte_size: null, width: null, height: null,
    thumbDataUrl: null,
    _uploadBlob: null,
  };
  state.landlordPhotos.push(placeholder);
  renderRooms();

  try {
    placeholder.status = 'processing'; renderRooms();
    placeholder.taken_at_exif = await extractExifDateTimeOriginal(file);
    const conv = await convertHeicIfNeeded(file);
    const { blob, width, height } = await resizeToJpeg(conv);
    placeholder.width = width; placeholder.height = height; placeholder.byte_size = blob.size;
    placeholder.thumbDataUrl = await blobToDataUrl(blob);
    placeholder._uploadBlob = blob;
    renderRooms();
    await uploadOne(placeholder);
  } catch (e) {
    placeholder.status = 'failed';
    placeholder.error = (e && e.message) || 'Photo failed';
    renderRooms();
  }
}

async function uploadOne(p){
  if (!p._uploadBlob) { p.status = 'failed'; renderRooms(); return; }
  p.status = 'uploading'; renderRooms();
  try {
    const path = p.storage_path || `${state.inspection.app_id}/${state.inspection.inspection_type}/${cryptoRandomId()}.jpg`;
    const { error } = await getSB().storage.from(PHOTO_BUCKET)
      .upload(path, p._uploadBlob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw new Error(error.message || 'Upload failed');
    p.storage_path = path;
    p.status = 'uploaded'; p.error = null;
    renderRooms();
  } catch (e) {
    p.status = 'failed'; p.error = (e && e.message) || 'Upload failed';
    renderRooms();
  }
}

async function convertHeicIfNeeded(file){
  const isHeic = /^image\/(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  if (!isHeic) return file;
  if (typeof window.heic2any !== 'function') throw new Error('HEIC converter still loading');
  const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(out) ? out[0] : out;
  return new File([blob], file.name.replace(/\.(heic|heif)$/i, '') + '.jpg', { type: 'image/jpeg' });
}
async function resizeToJpeg(file){
  const dataUrl = await blobToDataUrl(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode failed')); i.src = dataUrl; });
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, PHOTO_MAX_EDGE / longEdge);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', PHOTO_QUALITY));
  return { blob, width: w, height: h };
}
async function blobToDataUrl(blob){
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}
function cryptoRandomId(){
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Date.now() + '_' + Math.random().toString(16).slice(2);
}
async function extractExifDateTimeOriginal(file){
  if (!file || !file.type || !/jpeg|jpg/i.test(file.type)) return null;
  try {
    const head = await file.slice(0, 65536).arrayBuffer();
    const view = new DataView(head);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 < view.byteLength) {
      if (view.getUint8(off) !== 0xFF) return null;
      const marker = view.getUint8(off + 1); const segLen = view.getUint16(off + 2);
      if (marker === 0xE1) {
        const startEXIF = off + 4;
        if (view.getUint32(startEXIF) !== 0x45786966) return null;
        const tiffStart = startEXIF + 6;
        const little = view.getUint16(tiffStart) === 0x4949;
        const u16 = (o) => little ? view.getUint16(o, true) : view.getUint16(o, false);
        const u32 = (o) => little ? view.getUint32(o, true) : view.getUint32(o, false);
        const ifd0Off = tiffStart + u32(tiffStart + 4);
        const ifd0Cnt = u16(ifd0Off);
        let exifIfdPtr = 0;
        for (let i = 0; i < ifd0Cnt; i++) { const e = ifd0Off + 2 + i * 12; if (u16(e) === 0x8769) { exifIfdPtr = tiffStart + u32(e + 8); break; } }
        if (!exifIfdPtr) return null;
        const exifCnt = u16(exifIfdPtr);
        for (let i = 0; i < exifCnt; i++) {
          const e = exifIfdPtr + 2 + i * 12;
          if (u16(e) === 0x9003) {
            const cnt = u32(e + 4); const ptr = tiffStart + u32(e + 8);
            const bytes = new Uint8Array(view.buffer, ptr, Math.min(cnt, 20));
            let str = ''; for (let j = 0; j < bytes.length; j++) { const c = bytes[j]; if (c === 0) break; str += String.fromCharCode(c); }
            const m = str.match(/^(\d{4}):(\d{2}):(\d{2})\s(\d{2}):(\d{2}):(\d{2})$/);
            return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
          }
        }
        return null;
      }
      if (marker === 0xDA) return null;
      off += 2 + segLen;
    }
  } catch (_) {}
  return null;
}

// ── Signature pad ────────────────────────────────────────────────────
let _padInited = false;
function initSignaturePad(){
  const canvas = $('#sig-canvas'); const ctx = canvas.getContext('2d');
  let drawing = false, hasInk = !!state.signaturePngDataUrl, lastX = 0, lastY = 0;
  function resize(){
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1e293b';
  }
  function pos(e){ const r = canvas.getBoundingClientRect(); const t = (e.touches && e.touches[0]) || e; return { x: t.clientX - r.left, y: t.clientY - r.top }; }
  function start(e){ e.preventDefault(); drawing = true; const p = pos(e); lastX = p.x; lastY = p.y; }
  function move(e){ if (!drawing) return; e.preventDefault(); const p = pos(e); ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke(); lastX = p.x; lastY = p.y; if (!hasInk) hasInk = true; commit(); }
  function end(e){ if (e && e.preventDefault) e.preventDefault(); drawing = false; commit(); }
  function commit(){ state.signaturePngDataUrl = hasInk ? canvas.toDataURL('image/png') : null; refreshSubmit(); }
  if (!_padInited) {
    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    $('#sig-clear').addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; state.signaturePngDataUrl = null; refreshSubmit(); });
    window.addEventListener('resize', resize);
    _padInited = true;
  }
  setTimeout(() => {
    resize();
    if (state.signaturePngDataUrl && !hasInk) {
      const img = new Image();
      img.onload = () => {
        const ratio = window.devicePixelRatio || 1;
        ctx.drawImage(img, 0, 0, canvas.width / ratio, canvas.height / ratio);
        hasInk = true;
      };
      img.src = state.signaturePngDataUrl;
    }
  }, 60);
  $('#landlord-notes').addEventListener('input', e => { state._notes = e.target.value; });
}

// ── Footer + submit ─────────────────────────────────────────────────
function wireFooter(){
  $('#btn-back').addEventListener('click', () => history.length > 1 ? history.back() : (location.href = '/landlord/applications.html'));
  $('#btn-sign').addEventListener('click', submit);
}
function refreshSubmit(){
  $('#btn-sign').disabled = state.submitting || !state.signaturePngDataUrl;
}

async function submit(){
  $('#submit-error').style.display = 'none';
  $('#submit-ok').style.display = 'none';

  const pending = state.landlordPhotos.filter(p => p.status === 'uploading' || p.status === 'pending' || p.status === 'processing');
  if (pending.length) { showErr(`${pending.length} photo${pending.length===1?'':'s'} still uploading. Wait a moment and try again.`); return; }
  const failed = state.landlordPhotos.filter(p => p.status === 'failed');
  if (failed.length) { showErr(`${failed.length} photo upload${failed.length===1?'':'s'} failed. Tap each red tile to retry, or remove them.`); return; }

  // Merge any newly-uploaded landlord photos into rooms[*].items[*].landlord_photo_paths
  for (const p of state.landlordPhotos) {
    if (p.status !== 'uploaded' || !p.storage_path) continue;
    const room = state.rooms[p.room_key];
    if (!room || !Array.isArray(room.items)) continue;
    const item = room.items.find(it => (it.name || '') === p.item_key);
    if (!item) continue;
    if (!Array.isArray(item.landlord_photo_paths)) item.landlord_photo_paths = [];
    if (!item.landlord_photo_paths.includes(p.storage_path)) item.landlord_photo_paths.push(p.storage_path);
  }

  // Build photos[] (only the ones we uploaded this session — the edge fn appends to lease_inspection_photos)
  const photosPayload = state.landlordPhotos
    .filter(p => p.status === 'uploaded' && p.storage_path)
    .map(p => ({
      storage_path:  p.storage_path,
      room_key:      p.room_key,
      item_key:      p.item_key,
      taken_at_exif: p.taken_at_exif,
      byte_size:     p.byte_size,
      width:         p.width,
      height:        p.height,
    }));

  const body = {
    app_id:             state.inspection.app_id,
    inspection_type:    state.inspection.inspection_type,
    completed_at:       new Date().toISOString(),
    rooms:              state.rooms,
    notes:              $('#landlord-notes').value || null,
    landlord_sig_image: state.signaturePngDataUrl,
    photos:             photosPayload,
  };

  state.submitting = true; refreshSubmit();
  $('#btn-sign').textContent = 'Saving…';

  try {
    const sb = getSB();
    const { data: sess } = await sb.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) throw new Error('Session expired — please sign in again.');
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/record-inspection`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'apikey': CONFIG.SUPABASE_ANON_KEY },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error || !json.success) throw new Error(json.error || `Server returned ${res.status}`);
    $('#submit-ok').style.display = '';
    $('#submit-ok').innerHTML = `Inspection counter-signed and saved. A new signed PDF version has been added to the lease record.`;
    $('#btn-sign').textContent = 'Saved ✓';
    $('#btn-sign').disabled = true;
    state.submitting = false;
  } catch (e) {
    state.submitting = false;
    showErr((e && e.message) || 'Save failed.');
    $('#btn-sign').textContent = 'Counter-sign & Save';
    refreshSubmit();
  }
}
function showErr(msg){
  $('#submit-error').style.display = '';
  $('#submit-error').textContent = msg;
}
