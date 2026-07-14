(function(){
  'use strict';
  function readyDeps(){ return window.AdminShell && window.CP && CP.sb && CP.Auth; }
  function waitReady(ms){
    return new Promise((res,rej)=>{
      const start=Date.now();
      (function tick(){
        if(readyDeps()) return res();
        if(Date.now()-start>ms) return rej(new Error('Admin tools failed to load.'));
        setTimeout(tick,80);
      })();
    });
  }
  let S;

  let allProperties = [];
  let scanResults   = {};  // { [propId]: { overallFlag, perImage:[{url,flag,score}], saved } }
  let selectedIds   = new Set();
  let currentFilter = 'all';
  let scanning      = false;
  let _displayLimit = 50;

  // ─── Proxy URL builder ────────────────────────────────────────────────────
  async function proxyUrl(imageUrl){
    if(!window.CONFIG || !CONFIG.SUPABASE_URL) return imageUrl;
    const token = await CP.Auth.getAccessToken().catch(()=>'');
    if(!token) return imageUrl;
    return CONFIG.SUPABASE_URL.replace(/\/$/,'')
      + '/functions/v1/proxy-image?url='
      + encodeURIComponent(imageUrl)
      + '&token='
      + encodeURIComponent(token);
  }

  // ─── Load properties ──────────────────────────────────────────────────────
  async function load(){
    const okAuth = await S.requireAdmin();
    if(!okAuth) return;
    const { data, error } = await CP.sb()
      .from('properties')
      .select('id,title,address,status,created_at,property_photos(id,url,file_id,display_order,watermark_status)')
      .order('created_at',{ ascending:false });
    if(error){
      document.getElementById('props-list').innerHTML =
        '<div class="empty"><svg class="i"><use href="#i-alert"/></svg><h3>Failed to load</h3><p>'+S.esc(error.message)+'</p></div>';
      return;
    }
    allProperties = (data || []).map(p => {
      const photos = Array.isArray(p.property_photos) ? p.property_photos : [];
      const sorted = photos.slice().sort((a,b) => (a.display_order||0)-(b.display_order||0));
      const validPhotos = sorted.filter(x => x.url);
      return { ...p, photos: validPhotos, images: validPhotos.map(x => ({ url: x.url, id: x.id })) };
    });

    // Pre-populate scanResults from previously saved watermark_status values.
    // Photos still set to 'applied' (the upload default) count as unscanned.
    for(const p of allProperties){
      const hasStatus = p.photos.some(ph =>
        ph.watermark_status && ph.watermark_status !== 'applied' && ph.watermark_status !== 'unscanned'
      );
      if(!hasStatus) continue;
      const perImage = p.photos.map(ph => ({
        url:   ph.url,
        flag:  (ph.watermark_status && ph.watermark_status !== 'applied') ? ph.watermark_status : 'unscanned',
        score: null,
      }));
      const flagged   = perImage.filter(x => x.flag === 'watermark' || x.flag === 'branding').length;
      const allFlagged = flagged === perImage.length && perImage.length > 0;
      let overallFlag = 'clean';
      if(allFlagged)    overallFlag = 'all';
      else if(flagged)  overallFlag = 'some';
      scanResults[p.id] = { overallFlag, perImage, saved: true };
    }

    document.querySelector('.appbar-sub').textContent =
      allProperties.length + ' propert' + (allProperties.length===1?'y':'ies');
    renderCards();
    updateSaveBtn();
  }

  // ─── Persist scan results to property_photos.watermark_status ────────────
  async function saveScanResult(p){
    const result = scanResults[p.id];
    if(!result || result.saved) return true; // nothing new to save
    let allOk = true;
    for(const im of result.perImage){
      // Prefer update by photo ID (reliable); fall back to URL match
      let q = CP.sb().from('property_photos').update({ watermark_status: im.flag });
      if(im.photoId) {
        q = q.eq('id', im.photoId);
      } else {
        q = q.eq('property_id', p.id).eq('url', im.url);
      }
      const { error } = await q;
      if(error){ allOk = false; console.error('[wm] save error:', im.url, error); }
    }
    if(allOk) result.saved = true;
    return allOk;
  }

  async function saveAllUnsaved(){
    const unsaved = allProperties.filter(p => scanResults[p.id] && !scanResults[p.id].saved);
    if(!unsaved.length){ S.toast('Nothing new to save.', 'info'); return; }
    let ok=0, fail=0;
    for(const p of unsaved){
      const saved = await saveScanResult(p);
      if(saved) ok++; else fail++;
      // Patch the saved indicator on the card in real time
      const card = document.getElementById('card-'+p.id);
      if(card && saved) card.classList.add('wm-saved');
    }
    if(ok)   S.toast(`${ok} propert${ok===1?'y':'ies'} saved to database.`, 'success');
    if(fail) S.toast(`${fail} failed to save.`, 'error');
    updateSaveBtn();
  }

  function updateSaveBtn(){
    const unsaved = allProperties.filter(p => scanResults[p.id] && !scanResults[p.id].saved).length;
    const btn = document.getElementById('btn-save-all');
    if(!btn) return;
    btn.disabled = unsaved === 0;
    btn.textContent = unsaved ? `Save results (${unsaved})` : 'All saved';
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  function renderCards(){
    const allVisible = getVisibleProperties();
    const visible = allVisible.slice(0, _displayLimit);
    const list = document.getElementById('props-list');
    if(!visible.length){
      list.innerHTML = '<div class="empty"><svg class="i"><use href="#i-image"/></svg><h3>No properties</h3><p>Nothing matches this filter.</p></div>';
      updateSummary();
      return;
    }
    let html = '<div class="wm-grid">' + visible.map(cardHtml).join('') + '</div>';
    if(allVisible.length > _displayLimit){
      const remaining = allVisible.length - _displayLimit;
      html += '<div style="padding:20px;text-align:center">'
        + '<button class="btn btn-secondary" data-action="wm-load-more">'
        + 'Load more (' + remaining + ' remaining)'
        + '</button></div>';
    }
    list.innerHTML = html;
    updateSummary();
  }

  function cardHtml(p){
    const imgs   = p.images || [];
    const first  = imgs[0] || '';
    const result = scanResults[p.id];
    const flag   = result?.overallFlag || 'unscanned';
    const flagLabel = { all:'All flagged', some:'Some flagged', clean:'Clean', unscanned:'Not scanned' }[flag] || 'Not scanned';
    const isSel  = selectedIds.has(p.id);
    const isSaved = result?.saved;

    let stripHtml = '';
    if(result && result.perImage && result.perImage.length > 1){
      stripHtml = '<div class="wm-strip">'
        + result.perImage.map((img, i) => {
            const fCls = img.flag === 'watermark' ? 'wm-strip-dot all'
                       : img.flag === 'branding'  ? 'wm-strip-dot some'
                       : img.flag === 'unscanned'  ? 'wm-strip-dot unscanned'
                       :                             'wm-strip-dot clean';
            const scoreLabel = img.score !== null ? ` (score ${img.score})` : '';
            return `<span class="${fCls}" title="Image ${i+1}: ${img.flag}${scoreLabel}">${i+1}</span>`;
          }).join('')
        + '</div>';
    }

    const savedBadge = isSaved
      ? `<span class="wm-saved-badge" title="Results saved to database">Saved</span>`
      : '';

    return `<div class="wm-card ${isSel?'selected':''} ${isSaved?'wm-saved':''}" id="card-${S.esc(p.id)}">
      <div class="wm-thumb" data-action="lightbox" data-url="${S.esc(first)}" data-cap="${S.esc(p.title||'')}">
        ${first
          ? `<img src="${S.esc(first)}" alt="" loading="lazy">`
          : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:.75rem">No image</div>'}
        <span class="wm-flag ${flag}">${flagLabel}</span>
        <div class="wm-check" data-action="select-stop">
          <input type="checkbox" data-action="select" data-id="${S.esc(p.id)}" ${isSel?'checked':''}>
        </div>
        ${imgs.length>1 ? `<span class="wm-imgcount">${imgs.length} images</span>` : ''}
      </div>
      ${stripHtml}
      <div class="wm-body">
        <div class="wm-title">${S.esc(p.title||'(untitled)')}</div>
        <div class="wm-addr">${S.esc(p.address||'—')}</div>
        ${result ? `<div class="wm-score-row">${result.perImage.map((im,i)=>
          `<span class="wm-score-chip ${im.flag==='watermark'?'chip-red':im.flag==='branding'?'chip-amber':im.flag==='unscanned'?'chip-grey':'chip-green'}"
           title="${S.esc(im.url)}">img${i+1}${im.score!==null?' '+im.score:''}</span>`).join('')}</div>` : ''}
        ${savedBadge}
      </div>
      <div class="wm-foot">
        <button class="btn btn-ghost btn-sm" data-action="scan-one" data-id="${S.esc(p.id)}">
          ${result ? 'Re-scan' : 'Scan'}
        </button>
        <button class="btn btn-danger btn-sm" data-action="delete-one"
          data-id="${S.esc(p.id)}" data-title="${S.esc(p.title||'(untitled)')}">Delete</button>
      </div>
    </div>`;
  }

  // ─── Image analysis ───────────────────────────────────────────────────────
  async function scanProperty(p){
    const imgs = p.images || [];
    if(!imgs.length){
      scanResults[p.id] = { overallFlag:'unscanned', perImage:[], saved:false };
      return;
    }
    const perImage = [];
    // Batch image analysis 3 at a time for speed (sequential was O(n) RTTs per property)
    const BATCH = 3;
    for(let i = 0; i < imgs.length; i += BATCH){
      const slice = imgs.slice(i, i + BATCH);
      const results = await Promise.all(slice.map(img => {
        const url = typeof img === 'string' ? img : img.url;
        const photoId = typeof img === 'string' ? null : img.id;
        return analyzeImage(url).then(r => ({ url, photoId, ...r }));
      }));
      perImage.push(...results);
    }
    const flagged    = perImage.filter(x => x.flag === 'watermark' || x.flag === 'branding').length;
    const allFlagged = flagged === perImage.length && perImage.length > 0;
    let overallFlag  = 'clean';
    if(allFlagged)   overallFlag = 'all';
    else if(flagged) overallFlag = 'some';
    scanResults[p.id] = { overallFlag, perImage, saved: false };
  }

  async function scanAll(){
    if(scanning) return;
    scanning = true;
    const bar  = document.getElementById('scan-bar');
    const fill = document.getElementById('scan-fill');
    const txt  = document.getElementById('scan-text');
    bar.style.display = 'flex';
    fill.style.width  = '0%';
    let done = 0;
    for(const p of allProperties){
      txt.textContent = `Scanning ${done+1} / ${allProperties.length} — ${S.esc(p.title||p.id)}`;
      await scanProperty(p);
      // Auto-save result right away so progress is never lost
      await saveScanResult(p);
      done++;
      fill.style.width = Math.round(done / allProperties.length * 100) + '%';
      const card = document.getElementById('card-' + p.id);
      if(card){
        const res  = scanResults[p.id];
        const flag = res?.overallFlag || 'unscanned';
        const fl   = card.querySelector('.wm-flag');
        if(fl){ fl.className = 'wm-flag ' + flag; fl.textContent = ({all:'All flagged',some:'Some flagged',clean:'Clean',unscanned:'Not scanned'})[flag]; }
        if(res?.saved) card.classList.add('wm-saved');
      }
    }
    txt.textContent = `Done — ${allProperties.length} propert${allProperties.length===1?'y':'ies'} scanned`;
    setTimeout(() => { bar.style.display = 'none'; }, 1800);
    renderCards();
    updateSaveBtn();
    scanning = false;
  }

  async function analyzeImage(rawUrl){
    if(!rawUrl) return { flag:'unscanned', score:0 };
    let objectUrl = null;
    try {
      const px   = await proxyUrl(rawUrl);
      const resp = await fetch(px);
      if(!resp.ok) return { flag:'unscanned', score:0 };
      const blob = await resp.blob();
      objectUrl  = URL.createObjectURL(blob);
      const result = await analyzeBlob(objectUrl);
      return result;
    } catch(err){
      console.warn('[wm] analyzeImage failed:', err);
      return { flag:'unscanned', score:0 };
    } finally {
      if(objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  function analyzeBlob(blobUrl){
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const cW = Math.min(480, img.naturalWidth  || 480);
          const cH = img.naturalHeight
            ? Math.round(img.naturalHeight * (cW / img.naturalWidth))
            : Math.round(cW * 0.75);
          if(cW < 2 || cH < 2){ resolve({flag:'unscanned',score:0}); return; }
          canvas.width = cW; canvas.height = cH;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, cW, cH);

          const regions = [
            [0.00, 0.00, 0.28, 0.22],
            [0.72, 0.00, 0.28, 0.22],
            [0.00, 0.78, 0.28, 0.22],
            [0.72, 0.78, 0.28, 0.22],
            [0.30, 0.00, 0.40, 0.15],
            [0.30, 0.85, 0.40, 0.15],
            [0.00, 0.35, 0.18, 0.30],
            [0.82, 0.35, 0.18, 0.30],
            [0.25, 0.30, 0.50, 0.40],
            [0.10, 0.15, 0.30, 0.25],
            [0.60, 0.60, 0.30, 0.25],
            [0.35, 0.45, 0.30, 0.15],
          ];

          let maxScore = 0;
          for(const [fx,fy,fw,fh] of regions){
            const rx = Math.round(fx*cW), ry = Math.round(fy*cH);
            const rw = Math.max(4, Math.round(fw*cW));
            const rh = Math.max(4, Math.round(fh*cH));
            let px;
            try{ px = ctx.getImageData(rx,ry,rw,rh).data; } catch{ continue; }
            const s = scoreRegion(px, rw, rh);
            if(s > maxScore) maxScore = s;
          }

          const flag = maxScore >= 68 ? 'watermark'
                     : maxScore >= 40 ? 'branding'
                     :                  'clean';
          resolve({ flag, score: maxScore });
        } catch(e){
          console.warn('[wm] canvas error:', e);
          resolve({ flag:'unscanned', score:0 });
        }
      };
      img.onerror = () => resolve({ flag:'unscanned', score:0 });
      img.src = blobUrl;
      setTimeout(() => resolve({ flag:'unscanned', score:0 }), 12000);
    });
  }

  function scoreRegion(data, w, h){
    const n = data.length / 4;
    if(n < 4) return 0;

    let lumSum = 0, lumSqSum = 0;
    let nearWhiteCount = 0;
    let nearGreyCount  = 0;
    let highEdgeCount  = 0;
    const lums = new Float32Array(n);

    for(let i=0; i<data.length; i+=4){
      const r=data[i], g=data[i+1], b=data[i+2];
      const lum = 0.299*r + 0.587*g + 0.114*b;
      lums[i>>2] = lum;
      lumSum   += lum;
      lumSqSum += lum*lum;
      if(r>210 && g>210 && b>210) nearWhiteCount++;
      const diff = Math.max(r,g,b) - Math.min(r,g,b);
      if(diff < 20 && lum > 60 && lum < 210) nearGreyCount++;
    }

    for(let row=0; row<h; row++){
      for(let col=1; col<w; col++){
        const idx = row*w + col;
        if(Math.abs(lums[idx] - lums[idx-1]) > 70) highEdgeCount++;
      }
    }

    const mean     = lumSum / n;
    const variance = lumSqSum/n - mean*mean;
    const stdDev   = Math.sqrt(Math.max(0, variance));

    const whiteRatio = nearWhiteCount / n;
    const greyRatio  = nearGreyCount  / n;
    const edgeRatio  = highEdgeCount  / n;

    let score = 0;

    if(stdDev > 55 && whiteRatio > 0.12) score += 38;
    else if(stdDev > 40 && whiteRatio > 0.06) score += 22;

    if(greyRatio > 0.35 && stdDev > 30) score += 28;
    else if(greyRatio > 0.20 && stdDev > 20) score += 14;

    if(edgeRatio > 0.20) score += 30;
    else if(edgeRatio > 0.10) score += 16;
    else if(edgeRatio > 0.05) score += 6;

    if(stdDev < 25 && edgeRatio > 0.08) score += 18;

    return Math.min(100, Math.round(score));
  }

  // ─── Selection ───────────────────────────────────────────────────────────
  function toggleSelect(id, checked){
    if(checked) selectedIds.add(id); else selectedIds.delete(id);
    updateSelCount();
    const card = document.getElementById('card-' + id);
    if(card) card.classList.toggle('selected', checked);
  }
  function toggleSelectAll(checked){
    getVisibleProperties().forEach(p => {
      if(checked) selectedIds.add(p.id); else selectedIds.delete(p.id);
      const card = document.getElementById('card-' + p.id);
      if(card){
        card.classList.toggle('selected', checked);
        const chk = card.querySelector('input[type=checkbox]');
        if(chk) chk.checked = checked;
      }
    });
    updateSelCount();
  }
  function updateSelCount(){
    document.getElementById('sel-count').textContent = selectedIds.size;
    document.getElementById('btn-delete-sel').disabled = selectedIds.size === 0;
  }

  function getVisibleProperties(){
    if(currentFilter === 'all') return allProperties;
    if(currentFilter === 'all-watermarked')
      return allProperties.filter(p => scanResults[p.id]?.overallFlag === 'all');
    if(currentFilter === 'some-watermarked')
      return allProperties.filter(p => ['all','some'].includes(scanResults[p.id]?.overallFlag));
    if(currentFilter === 'clean')
      return allProperties.filter(p => scanResults[p.id]?.overallFlag === 'clean');
    return allProperties;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────
  async function deleteOne(id, title){
    const ok = await S.confirm({
      title:   'Delete this property?',
      message: `"${title}" will be permanently removed along with all its data. This cannot be undone.`,
      ok:      'Delete property',
      danger:  true,
    });
    if(!ok) return;
    await doDelete([id]);
  }
  async function deleteSelected(){
    if(!selectedIds.size) return;
    const ids = [...selectedIds];
    const ok  = await S.confirm({
      title:   `Delete ${ids.length} propert${ids.length===1?'y':'ies'}?`,
      message: 'This will permanently remove them and all related data. This cannot be undone.',
      ok:      'Delete all',
      danger:  true,
    });
    if(!ok) return;
    await doDelete(ids);
  }
  async function doDelete(ids){
    let succeeded=0, failed=0;
    for(const id of ids){
      const { error } = await CP.sb().from('properties').delete().eq('id', id);
      if(error){ console.error('Delete error', id, error); failed++; }
      else{
        // Log to admin_actions for audit trail (non-blocking)
        CP.Auth.getSession().then(({ data }) => {
          CP.sb().from('admin_actions').insert([{
            user_id:     data?.session?.user?.id || null,
            action:      'property.hard_delete',
            target_type: 'property',
            target_id:   id,
            metadata:    { source: 'watermark-review' }
          }]).then(() => {}).catch(() => {});
        }).catch(() => {});
        succeeded++;
        allProperties = allProperties.filter(p => p.id !== id);
        delete scanResults[id];
        selectedIds.delete(id);
        const card = document.getElementById('card-' + id);
        if(card){
          card.style.transition = 'opacity .3s';
          card.style.opacity    = '0';
          setTimeout(() => card.remove(), 320);
        }
      }
    }
    updateSelCount();
    updateSummary();
    updateSaveBtn();
    if(succeeded) S.toast(`${succeeded} propert${succeeded===1?'y':'ies'} deleted.`, 'success');
    if(failed)    S.toast(`${failed} failed to delete.`, 'error');
    document.querySelector('.appbar-sub').textContent =
      allProperties.length + ' propert' + (allProperties.length===1?'y':'ies');
  }

  // ─── Summary bar ─────────────────────────────────────────────────────────
  function updateSummary(){
    const scanned = allProperties.filter(p => scanResults[p.id]);
    if(!scanned.length){ document.getElementById('summary-bar').style.display='none'; return; }
    const allF  = scanned.filter(p => scanResults[p.id]?.overallFlag==='all').length;
    const someF = scanned.filter(p => scanResults[p.id]?.overallFlag==='some').length;
    const clean = scanned.filter(p => scanResults[p.id]?.overallFlag==='clean').length;
    document.getElementById('sum-all').textContent   = `${allF} fully watermarked`;
    document.getElementById('sum-some').textContent  = `${someF} partially flagged`;
    document.getElementById('sum-clean').textContent = `${clean} clean`;
    document.getElementById('sum-total').textContent = `${scanned.length} scanned`;
    document.getElementById('summary-bar').style.display = 'flex';
  }

  // ─── Lightbox ────────────────────────────────────────────────────────────
  function openLightbox(url, caption){
    if(!url) return;
    document.getElementById('lightbox-img').src  = url;
    document.getElementById('lightbox-caption').textContent = caption || '';
    document.getElementById('lightbox').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox(){
    document.getElementById('lightbox').classList.remove('open');
    document.getElementById('lightbox-img').src = '';
    document.body.style.overflow = '';
  }

  // ─── Boot ────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch(e){
      const el = document.getElementById('props-list');
      if(el) el.innerHTML =
        '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
      return;
    }
    S = window.AdminShell;

    S.on('lightbox',    (t) => openLightbox(t.dataset.url, t.dataset.cap));
    S.on('select',      (t, e) => { e.stopPropagation(); toggleSelect(t.dataset.id, t.checked); });
    S.on('select-stop', (_, e) => e.stopPropagation());
    S.on('delete-one',  (t) => deleteOne(t.dataset.id, t.dataset.title));
    S.on('scan-one', async (t) => {
      const p = allProperties.find(x => x.id === t.dataset.id);
      if(!p) return;
      t.disabled    = true;
      t.textContent = 'Scanning…';
      await scanProperty(p);
      // Auto-save immediately after individual scan
      const saved = await saveScanResult(p);
      const card  = document.getElementById('card-' + p.id);
      if(card){
        const tmp = document.createElement('div');
        tmp.innerHTML = cardHtml(p);
        card.replaceWith(tmp.firstElementChild);
      }
      updateSummary();
      updateSaveBtn();
      if(saved) S.toast('Scan result saved.', 'success');
      t.disabled = false;
    });

    document.getElementById('btn-scan-all').addEventListener('click',  () => scanAll());
    document.getElementById('btn-save-all').addEventListener('click',  () => saveAllUnsaved());
    document.getElementById('btn-delete-sel').addEventListener('click', () => deleteSelected());
    document.getElementById('select-all').addEventListener('change', e => toggleSelectAll(e.target.checked));
    document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
    document.getElementById('lightbox').addEventListener('click', e => { if(e.target.id==='lightbox') closeLightbox(); });
    document.addEventListener('keydown', e => { if(e.key==='Escape') closeLightbox(); });
    S.on('wm-load-more', () => {
      _displayLimit += 50;
      renderCards();
    });

    document.getElementById('filter-tabs').addEventListener('click', e => {
      const btn = e.target.closest('.chip');
      if(!btn) return;
      document.querySelectorAll('#filter-tabs .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      _displayLimit = 50;
      renderCards();
    });

    await load();

    // ─── Real-time updates ──────────────────────────────────────────────────
    // Reflect edits/deletes/inserts made elsewhere (another admin tab, the
    // property editor, a re-publish) without requiring a manual refresh.
    let _rtReloadTimer = null;
    function scheduleReload(){
      // Debounce: bulk operations can fire many change events in quick
      // succession (e.g. deleting 10 selected properties).
      clearTimeout(_rtReloadTimer);
      _rtReloadTimer = setTimeout(() => { load().catch(()=>{}); }, 400);
    }
    try {
      CP.sb()
        .channel('watermark-review-properties')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'properties' }, scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'property_photos' }, scheduleReload)
        .subscribe();
    } catch(e){
      console.warn('[watermark-review] realtime subscription failed — falling back to manual refresh', e);
    }

    // If launched from property-detail with ?property_id=, scroll to and highlight that property
    const _focusPropId = new URLSearchParams(location.search).get('property_id');
    if (_focusPropId) {
      const card = document.getElementById('card-' + _focusPropId);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        card.style.outline = '2px solid var(--brand)';
        card.style.borderRadius = 'var(--r-md, 8px)';
        setTimeout(() => { card.style.outline = ''; card.style.borderRadius = ''; }, 3000);
      }
    }
  });
})();
