(function(){
  'use strict';
  // Wait for AdminShell, CP, and auth before doing anything.
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
  let scanResults   = {};  // { [propId]: { overallFlag, perImage:[{url,flag,score}] } }
  let selectedIds   = new Set();
  let currentFilter = 'all';
  let scanning      = false;

  // ─── Proxy URL builder ────────────────────────────────────────────────────
  // Routes every ImageKit image through our CORS-safe edge proxy so that
  // canvas.getImageData() doesn't throw a SecurityError.
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

  // ─── Load properties ─────────────────────────────────────────────────────
  async function load(){
    const okAuth = await S.requireAdmin();
    if(!okAuth) return;
    // Phase 3c: photos are in property_photos — join and sort by display_order.
    const { data, error } = await CP.sb()
      .from('properties')
      .select('id,title,address,status,created_at,property_photos(url,file_id,display_order)')
      .order('created_at',{ ascending:false });
    if(error){
      document.getElementById('props-list').innerHTML =
        '<div class="empty"><svg class="i"><use href="#i-alert"/></svg><h3>Failed to load</h3><p>'+S.esc(error.message)+'</p></div>';
      return;
    }
    // Normalize: derive a sorted images[] array from property_photos join.
    allProperties = (data || []).map(p => {
      const photos = Array.isArray(p.property_photos) ? p.property_photos : [];
      const sorted = photos.slice().sort((a,b) => (a.display_order||0)-(b.display_order||0));
      return { ...p, images: sorted.map(x => x.url).filter(Boolean) };
    });
    document.querySelector('.appbar-sub').textContent =
      allProperties.length + ' propert' + (allProperties.length===1?'y':'ies');
    renderCards();
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  function renderCards(){
    const visible = getVisibleProperties();
    const list = document.getElementById('props-list');
    if(!visible.length){
      list.innerHTML = '<div class="empty"><svg class="i"><use href="#i-image"/></svg><h3>No properties</h3><p>Nothing matches this filter.</p></div>';
      updateSummary();
      return;
    }
    list.innerHTML = '<div class="wm-grid">' + visible.map(cardHtml).join('') + '</div>';
    updateSummary();
  }

  function cardHtml(p){
    const imgs = p.images || [];
    const first = imgs[0] || '';
    const result = scanResults[p.id];
    const flag = result?.overallFlag || 'unscanned';
    const flagLabel = { all:'All flagged', some:'Some flagged', clean:'Clean', unscanned:'Not scanned' }[flag] || 'Not scanned';
    const isSel = selectedIds.has(p.id);

    // Per-image result strip (visible after scanning)
    let stripHtml = '';
    if(result && result.perImage && result.perImage.length > 1){
      stripHtml = '<div class="wm-strip">'
        + result.perImage.map((img, i) => {
            const fCls = img.flag === 'watermark' ? 'wm-strip-dot all'
                       : img.flag === 'branding'  ? 'wm-strip-dot some'
                       : img.flag === 'unscanned'  ? 'wm-strip-dot unscanned'
                       :                             'wm-strip-dot clean';
            return `<span class="${fCls}" title="Image ${i+1}: ${img.flag} (score ${img.score||0})">${i+1}</span>`;
          }).join('')
        + '</div>';
    }

    return `<div class="wm-card ${isSel?'selected':''}" id="card-${S.esc(p.id)}">
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
           title="${S.esc(im.url)}">img${i+1} ${im.score||0}</span>`).join('')}</div>` : ''}
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
      scanResults[p.id] = { overallFlag:'unscanned', perImage:[] };
      return;
    }
    const perImage = [];
    for(const url of imgs){
      const { flag, score } = await analyzeImage(url);
      perImage.push({ url, flag, score });
    }
    const flagged = perImage.filter(x => x.flag === 'watermark' || x.flag === 'branding').length;
    const allFlagged = flagged === perImage.length;
    let overallFlag = 'clean';
    if(allFlagged && flagged > 0) overallFlag = 'all';
    else if(flagged > 0)          overallFlag = 'some';
    scanResults[p.id] = { overallFlag, perImage };
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
      done++;
      fill.style.width = Math.round(done / allProperties.length * 100) + '%';
      // Live-patch the card's flag badge without full re-render.
      const card = document.getElementById('card-' + p.id);
      if(card){
        const res = scanResults[p.id];
        const flag = res?.overallFlag || 'unscanned';
        const fl = card.querySelector('.wm-flag');
        if(fl){
          fl.className = 'wm-flag ' + flag;
          fl.textContent = ({all:'All flagged',some:'Some flagged',clean:'Clean',unscanned:'Not scanned'})[flag];
        }
      }
    }
    txt.textContent = `Done — ${allProperties.length} propert${allProperties.length===1?'y':'ies'} scanned`;
    setTimeout(() => { bar.style.display = 'none'; }, 1800);
    // Full re-render to show per-image strips.
    renderCards();
    scanning = false;
  }

  // Fetch via our CORS proxy, then analyze on a canvas.
  async function analyzeImage(rawUrl){
    if(!rawUrl) return { flag:'unscanned', score:0 };
    let objectUrl = null;
    try {
      const px = await proxyUrl(rawUrl);
      const resp = await fetch(px);
      if(!resp.ok) return { flag:'unscanned', score:0 };
      const blob = await resp.blob();
      objectUrl = URL.createObjectURL(blob);
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

          // Sample 12 regions targeting the most common watermark placements:
          // corners, mid-edges, diagonal bands, centre.
          const regions = [
            // Corners (most common watermark zones)
            [0.00, 0.00, 0.28, 0.22],
            [0.72, 0.00, 0.28, 0.22],
            [0.00, 0.78, 0.28, 0.22],
            [0.72, 0.78, 0.28, 0.22],
            // Mid-edges
            [0.30, 0.00, 0.40, 0.15],
            [0.30, 0.85, 0.40, 0.15],
            [0.00, 0.35, 0.18, 0.30],
            [0.82, 0.35, 0.18, 0.30],
            // Centre
            [0.25, 0.30, 0.50, 0.40],
            // Diagonal strips (MLS / Zillow watermarks span diagonally)
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

  // Score a region's pixel data for watermark-like visual signatures.
  // Works for JPEG (no alpha) by using luminance variance, edge density,
  // and near-white/near-grey pixel ratios — properties common to text/logo overlays.
  function scoreRegion(data, w, h){
    const n = data.length / 4;
    if(n < 4) return 0;

    let lumSum = 0, lumSqSum = 0;
    let nearWhiteCount = 0; // pixels close to white — common in overlaid text
    let nearGreyCount  = 0; // flat grey — typical of semi-transparent logos
    let highEdgeCount  = 0; // sharp luminance change to adjacent pixel
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

    // Count edge transitions (high Δlum between horizontally adjacent pixels)
    for(let row=0; row<h; row++){
      for(let col=1; col<w; col++){
        const idx = row*w + col;
        if(Math.abs(lums[idx] - lums[idx-1]) > 70) highEdgeCount++;
      }
    }

    const mean    = lumSum / n;
    const variance = lumSqSum/n - mean*mean;
    const stdDev  = Math.sqrt(Math.max(0, variance));

    const whiteRatio = nearWhiteCount / n;
    const greyRatio  = nearGreyCount  / n;
    const edgeRatio  = highEdgeCount  / n;

    let score = 0;

    // High-variance region with significant white presence → likely text overlay
    if(stdDev > 55 && whiteRatio > 0.12) score += 38;
    else if(stdDev > 40 && whiteRatio > 0.06) score += 22;

    // Flat grey with high brightness variance → semi-transparent logo
    if(greyRatio > 0.35 && stdDev > 30) score += 28;
    else if(greyRatio > 0.20 && stdDev > 20) score += 14;

    // High edge density in a localised region → sharp text/logo elements
    if(edgeRatio > 0.20) score += 30;
    else if(edgeRatio > 0.10) score += 16;
    else if(edgeRatio > 0.05) score += 6;

    // Bonus: very uniform brightness (flat region) with occasional sharp edges
    // typical of a ghost/watermark text overlaid on a photo background.
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
    const ok = await S.confirm({
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
      t.disabled = true;
      t.textContent = 'Scanning…';
      await scanProperty(p);
      // Re-render just this card
      const card = document.getElementById('card-' + p.id);
      if(card){
        const tmp = document.createElement('div');
        tmp.innerHTML = cardHtml(p);
        card.replaceWith(tmp.firstElementChild);
      }
      updateSummary();
      t.disabled = false;
    });

    document.getElementById('btn-scan-all').addEventListener('click',  () => scanAll());
    document.getElementById('btn-delete-sel').addEventListener('click', () => deleteSelected());
    document.getElementById('select-all').addEventListener('change', e => toggleSelectAll(e.target.checked));
    document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
    document.getElementById('lightbox').addEventListener('click', e => { if(e.target.id==='lightbox') closeLightbox(); });
    document.addEventListener('keydown', e => { if(e.key==='Escape') closeLightbox(); });
    document.getElementById('filter-tabs').addEventListener('click', e => {
      const btn = e.target.closest('.chip');
      if(!btn) return;
      document.querySelectorAll('#filter-tabs .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderCards();
    });

    await load();
  });
})();
