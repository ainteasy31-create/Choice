// js/landlord/new-listing.js
  // Extracted from landlord/new-listing.html (issue #27). Loaded as <script type="module">.
  // Multi-step listing-creation wizard: photos, geocode, draft autosave, validate, submit.
  // Imports use absolute /js/... paths because the file lives in /js/landlord/.

    import { requireAuth, getLandlordProfile, supabase } from '/js/cp-api.js';
  import { uploadToImageKit, deleteFromImageKit } from '/js/imagekit.js';
  import { STATES, whenSidebarReady, installImageFallback } from '/js/landlord/shared.js';

  installImageFallback();

  await requireAuth('/landlord/login.html');
  const profile = await getLandlordProfile();
  if (!profile) { window.location.href = '/landlord/login.html'; throw new Error(); }

  // Wire chrome's sign-out (delegated)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="sign-out"]');
    if (btn) {
      e.preventDefault();
      supabase.auth.signOut().then(() => { window.location.href = '/landlord/login.html'; });
    }
  });

  // Sidebar info via chrome
  whenSidebarReady(() => {
    const nameEl = document.getElementById('admin-name');
    if (nameEl) {
      const display = profile.business_name || profile.contact_name || '';
      nameEl.textContent = display + (profile.email ? ' · ' + profile.email : '');
    }
  });

  // Populate state dropdown (STATES imported from shared.js)
  const stateSel = document.getElementById('state');
  STATES.forEach(([c,n]) => { const o = document.createElement('option'); o.value = c; o.textContent = n; stateSel.appendChild(o); });

  let currentStep = 1;
  const totalSteps = 6;
  const pendingFiles = [];
  const pendingPreviews = [];
  // Issue #14b: per-photo upload state, parallel-indexed to pendingFiles.
  //   uploads[i] = { status: 'uploading' | 'ready' | 'error',
  //                  url?, fileId?, error?, _promise? }
  // Photos are uploaded to ImageKit as the landlord adds them so they
  // survive a draft resume; at submit time we just call add_property_photo
  // for each entry that already reached 'ready'.
  const uploads = [];
  let geocodedLat = null;
  let geocodedLng = null;
  let _geocodePromise = null;

  // ── Geocode address via Geoapify ──
  function geocodeAddress() {
    const addr = `${v('address')}, ${v('city')}, ${v('state')} ${v('zip')}`.trim();
    geocodedLat = null;
    geocodedLng = null;
    if (!addr || addr.length < 10) return;
    const apiKey = (typeof CONFIG !== 'undefined' && CONFIG.GEOAPIFY_API_KEY) || '';
    if (!apiKey) return;
    _geocodePromise = (async () => {
      try {
        const res = await fetch(
          `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(addr)}&format=json&apiKey=${apiKey}&filter=countrycode:us&limit=1`
        );
        const data = await res.json();
        const hit = data?.results?.[0];
        if (hit) {
          geocodedLat = parseFloat(hit.lat);
          geocodedLng = parseFloat(hit.lon);
        }
      } catch (e) { /* silent */ }
    })();
  }

  let _geocodeDebounce = null;
  function _scheduleGeocode() { clearTimeout(_geocodeDebounce); _geocodeDebounce = setTimeout(geocodeAddress, 800); }
  ['address', 'city', 'zip'].forEach(id => { document.getElementById(id).addEventListener('input', _scheduleGeocode); });
  document.getElementById('state').addEventListener('change', _scheduleGeocode);

  // App fee
  const appFeeInput = document.getElementById('appFee');
  appFeeInput.value = '';
  document.getElementById('appFeeHint').textContent =
    'Enter 0 if free to apply. This amount will be shown to applicants before they submit.';

  // Title counter
  document.getElementById('title').addEventListener('input', e => {
    document.getElementById('titleCount').textContent = e.target.value.length;
  });

  let propId = null;

  // ── Issue #14b: per-session draft photo folder + background upload ──
  // Each fresh draft session gets its own folder under
  // /properties/_drafts/<token>/ in ImageKit, so abandoned drafts can be
  // cleaned up later without colliding with live property IDs.
  function _draftPhotoToken() {
    let t = sessionStorage.getItem('cp_draft_photo_token');
    if (!t) {
      t = (window.crypto?.randomUUID?.()) ||
          (Date.now().toString(36) + Math.random().toString(36).slice(2));
      sessionStorage.setItem('cp_draft_photo_token', t);
    }
    return t;
  }

  // Kick off a background upload for pendingFiles[idx] / uploads[idx].
  // Sets uploads[idx].status to 'ready' or 'error' and triggers a re-render
  // + autosave on completion. Returns a promise that resolves either way.
  function kickPhotoUpload(idx) {
    const file = pendingFiles[idx];
    if (!file || file._restored) return Promise.resolve();
    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
      uploads[idx] = { status: 'error', error: 'Photo upload is not configured.' };
      renderPhotoGrid();
      return Promise.resolve();
    }
    const slot = uploads[idx] = { status: 'uploading' };
    const folder = `/properties/_drafts/${_draftPhotoToken()}`;
    const p = (async () => {
      try {
        const accessToken = await window.CP?.Auth?.getAccessToken?.();
        if (!accessToken) throw new Error('Session expired — please log back in.');
        const r = await uploadToImageKit(file, {
          folder,
          supabaseUrl: CONFIG.SUPABASE_URL,
          anonKey:     CONFIG.SUPABASE_ANON_KEY,
          userToken:   accessToken,
          // No propertyId — listing doesn't exist yet. We commit to
          // property_photos at submit time via add_property_photo.
        });
        if (uploads[idx] === slot) {
          slot.status = 'ready';
          slot.url    = r.url;
          slot.fileId = r.fileId || null;
          renderPhotoGrid();
          autosaveDraft();
        }
      } catch (e) {
        if (uploads[idx] === slot) {
          slot.status = 'error';
          slot.error  = (e && e.message) || String(e);
          renderPhotoGrid();
        }
      }
    })();
    slot._promise = p;
    return p;
  }

  // ── Autosave to localStorage ──
  let _draftDirty = false;

  function autosaveDraft() {
    _draftDirty = true;
    const draft = {
      savedAt:       Date.now(),
      title:         document.getElementById('title').value,
      propertyType:  document.getElementById('propertyType').value,
      address:       document.getElementById('address').value,
      city:          document.getElementById('city').value,
      state:         document.getElementById('state').value,
      zip:           document.getElementById('zip').value,
      bedrooms:      document.getElementById('bedrooms').value,
      bathrooms:     document.getElementById('bathrooms').value,
      sqft:          document.getElementById('sqft').value,
      rent:          document.getElementById('rent').value,
      deposit:       document.getElementById('deposit').value,
      lastMonthRent: document.getElementById('lastMonthRent').value,
      adminFee:      document.getElementById('adminFee').value,
      moveInSpecial: document.getElementById('moveInSpecial').value,
      availDate:     document.getElementById('availDate').value,
      appFee:        document.getElementById('appFee').value,
      parking:       document.getElementById('parking').value,
      garageSpaces:  document.getElementById('garageSpaces').value,
      parkingFee:    document.getElementById('parkingFee').value,
      evCharging:    document.getElementById('evCharging').value,
      petDetails:    document.getElementById('petDetails').value,
      petWeightLimit:document.getElementById('petWeightLimit').value,
      petDeposit:    document.getElementById('petDeposit').value,
      laundryType:   document.getElementById('laundryType').value,
      heatingType:   document.getElementById('heatingType').value,
      coolingType:   document.getElementById('coolingType').value,
      description:   document.getElementById('description').value,
      showingInstructions: document.getElementById('showingInstructions').value,
      petsAllowed:   document.querySelector('input[name="pets"]:checked')?.value || 'false',
      petTypes:      [...document.querySelectorAll('#petTypesGroup input:checked')].map(c => c.value),
      availType:     document.querySelector('input[name="availType"]:checked')?.value || 'now',
      leaseTerms:    [...document.querySelectorAll('#step2 .checkbox-group input:checked')].map(c => c.value),
      utilities:     [...document.querySelectorAll('#utilitiesGroup input:checked')].map(c => c.value),
      amenities:     [...document.querySelectorAll('#amenitiesGroup input:checked')].map(c => c.value),
      // Issue #14b: persist already-uploaded photos so a draft resume
      // brings them back instead of forcing the landlord to re-upload.
      // We only save 'ready' photos (URL + fileId from ImageKit). Photos
      // still uploading or in error state are skipped — they have no
      // canonical URL yet, so they're effectively lost on resume (the
      // landlord can re-add them).
      photos:        uploads.map((u, i) => (u && u.status === 'ready') ? {
        url:      u.url,
        fileId:   u.fileId || null,
        name:     pendingFiles[i]?.name || '',
        size:     pendingFiles[i]?.size || 0,
      } : null).filter(Boolean),
    };
    localStorage.setItem('cp_draft_s1', JSON.stringify(draft));
  }

  ['title','address','city','zip','sqft','rent','deposit','availDate','appFee','petDetails','description','showingInstructions','lastMonthRent','adminFee','moveInSpecial','parkingFee','petDeposit']
    .forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', autosaveDraft); });
  ['propertyType','state','bedrooms','bathrooms','parking','garageSpaces','evCharging','petWeightLimit','laundryType','heatingType','coolingType']
    .forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('change', autosaveDraft); });
  document.querySelectorAll('#step2 .checkbox-group input, #utilitiesGroup input, #amenitiesGroup input, input[name="pets"], #petTypesGroup input')
    .forEach(el => el.addEventListener('change', autosaveDraft));

  window.addEventListener('beforeunload', (e) => {
    if (_draftDirty && currentStep < 6) { e.preventDefault(); e.returnValue = ''; }
  });

  // ── Apply draft to form ──
  function applyDraftToForm(s1) {
    if (s1.title)        { document.getElementById('title').value = s1.title; document.getElementById('titleCount').textContent = s1.title.length; }
    if (s1.propertyType) document.getElementById('propertyType').value = s1.propertyType;
    if (s1.address)      document.getElementById('address').value = s1.address;
    if (s1.city)         document.getElementById('city').value = s1.city;
    if (s1.state)        document.getElementById('state').value = s1.state;
    if (s1.zip)          document.getElementById('zip').value = s1.zip;
    if (s1.bedrooms)     document.getElementById('bedrooms').value = s1.bedrooms;
    if (s1.bathrooms)    document.getElementById('bathrooms').value = s1.bathrooms;
    if (s1.sqft)         document.getElementById('sqft').value = s1.sqft;
    if (s1.rent)         document.getElementById('rent').value = s1.rent;
    if (s1.deposit)      document.getElementById('deposit').value = s1.deposit;
    if (s1.lastMonthRent !== undefined) document.getElementById('lastMonthRent').value = s1.lastMonthRent;
    if (s1.adminFee !== undefined)      document.getElementById('adminFee').value = s1.adminFee;
    if (s1.moveInSpecial) document.getElementById('moveInSpecial').value = s1.moveInSpecial;
    if (s1.availDate)    document.getElementById('availDate').value = s1.availDate;
    if (s1.appFee !== undefined) document.getElementById('appFee').value = s1.appFee;
    if (s1.parking)      document.getElementById('parking').value = s1.parking;
    if (s1.garageSpaces !== undefined) document.getElementById('garageSpaces').value = s1.garageSpaces;
    if (s1.parkingFee !== undefined)   document.getElementById('parkingFee').value = s1.parkingFee;
    if (s1.evCharging)   document.getElementById('evCharging').value = s1.evCharging;
    if (s1.petDetails)   document.getElementById('petDetails').value = s1.petDetails;
    if (s1.petWeightLimit !== undefined) document.getElementById('petWeightLimit').value = s1.petWeightLimit;
    if (s1.petDeposit !== undefined)   document.getElementById('petDeposit').value = s1.petDeposit;
    if (s1.laundryType)  document.getElementById('laundryType').value = s1.laundryType;
    if (s1.heatingType)  document.getElementById('heatingType').value = s1.heatingType;
    if (s1.coolingType)  document.getElementById('coolingType').value = s1.coolingType;
    if (s1.availType) {
      const availRadio = document.querySelector(`input[name="availType"][value="${s1.availType}"]`);
      if (availRadio) { availRadio.checked = true; _setAvailDateVisibility(s1.availType); }
    }
    if (s1.petsAllowed) {
      const petsRadio = document.querySelector(`input[name="pets"][value="${s1.petsAllowed}"]`);
      if (petsRadio) { petsRadio.checked = true; document.getElementById('petDetailsWrap').style.display = s1.petsAllowed === 'true' ? '' : 'none'; }
    }
    if (Array.isArray(s1.petTypes) && s1.petTypes.length) {
      document.querySelectorAll('#petTypesGroup input').forEach(cb => { cb.checked = s1.petTypes.includes(cb.value); });
    }
    if (Array.isArray(s1.leaseTerms) && s1.leaseTerms.length) {
      document.querySelectorAll('#step2 .checkbox-group input').forEach(cb => { cb.checked = s1.leaseTerms.includes(cb.value); });
    }
    if (Array.isArray(s1.utilities) && s1.utilities.length) {
      document.querySelectorAll('#utilitiesGroup input').forEach(cb => { cb.checked = s1.utilities.includes(cb.value); });
    }
    if (Array.isArray(s1.amenities) && s1.amenities.length) {
      document.querySelectorAll('#amenitiesGroup input').forEach(cb => { cb.checked = s1.amenities.includes(cb.value); });
    }
    if (s1.description) {
      document.getElementById('description').value = s1.description;
      document.getElementById('descCount').textContent = s1.description.length;
    }
    if (s1.showingInstructions) document.getElementById('showingInstructions').value = s1.showingInstructions;
    // Issue #14b: restore previously-uploaded photos. We don't have the
    // original File objects any more, so we use placeholder entries
    // marked _restored so kickPhotoUpload skips them. The grid renders
    // them straight from the ImageKit URL.
    if (Array.isArray(s1.photos) && s1.photos.length) {
      for (const ph of s1.photos) {
        if (!ph || !ph.url) continue;
        pendingFiles.push({
          _restored: true,
          name: ph.name || 'photo',
          size: ph.size || 0,
        });
        pendingPreviews.push(ph.url);
        uploads.push({
          status: 'ready',
          url:    ph.url,
          fileId: ph.fileId || null,
        });
      }
      renderPhotoGrid();
    }
  }

  // ── Resume banner ──
  try {
    const s1 = JSON.parse(localStorage.getItem('cp_draft_s1') || 'null');
    if (s1) {
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      const age = Date.now() - (s1.savedAt || 0);

      if (age >= SEVEN_DAYS) {
        localStorage.removeItem('cp_draft_s1');
        localStorage.removeItem('cp_draft_propid');
        sessionStorage.removeItem('cp_draft_photo_token'); // Issue #14b
      } else {
        const banner = document.getElementById('resumeBanner');
        const ageEl = document.getElementById('resumeBannerAge');
        const daysOld = Math.floor(age / (24 * 60 * 60 * 1000));
        const hoursOld = Math.floor(age / (60 * 60 * 1000));
        const minsOld = Math.floor(age / (60 * 1000));
        ageEl.textContent = daysOld >= 1 ? `(saved ${daysOld}d ago)`
                          : hoursOld >= 1 ? `(saved ${hoursOld}h ago)`
                          : minsOld >= 1 ? `(saved ${minsOld}m ago)`
                          : '(just saved)';
        banner.style.display = 'block';

        document.getElementById('resumeDraftBtn').addEventListener('click', () => {
          applyDraftToForm(s1);
          banner.style.display = 'none';
          _draftDirty = false;
          CP.UI.toast('Draft restored.', 'success');
        });
        document.getElementById('discardDraftBtn').addEventListener('click', () => {
          localStorage.removeItem('cp_draft_s1');
          localStorage.removeItem('cp_draft_propid');
          sessionStorage.removeItem('cp_draft_photo_token'); // Issue #14b
          banner.style.display = 'none';
          CP.UI.toast('Draft discarded.', 'info');
        });
      }
    }
  } catch(e) {}

  // ── Availability toggle ──
  function _setAvailDateVisibility(type) {
    const el = document.getElementById('availDate');
    if (type === 'future') {
      el.style.display = '';
      el.min = new Date().toISOString().split('T')[0];
    } else {
      el.style.display = 'none';
      el.value = '';
    }
  }
  document.querySelectorAll('input[name="availType"]').forEach(r => {
    r.addEventListener('change', () => { _setAvailDateVisibility(r.value); autosaveDraft(); });
  });

  // ── Navigation ──
  document.getElementById('next1').addEventListener('click', () => validate1() && goTo(2));
  document.getElementById('next2').addEventListener('click', () => validate2() && goTo(3));
  document.getElementById('next3').addEventListener('click', () => validate3() && goTo(4));
  document.getElementById('next4').addEventListener('click', () => validatePhotos() && goTo(5));
  document.getElementById('next5').addEventListener('click', () => validate5() && goTo(6));
  document.getElementById('prev2').addEventListener('click', () => goTo(1));
  document.getElementById('prev3').addEventListener('click', () => goTo(2));
  document.getElementById('prev4').addEventListener('click', () => goTo(3));
  document.getElementById('prev5').addEventListener('click', () => goTo(4));
  document.getElementById('prev6').addEventListener('click', () => goTo(5));
  document.getElementById('submitBtn').addEventListener('click', submitListing);

  // ── Compress for sessionStorage preview ──
  function _compressForPreview(dataUrl, maxW = 900, quality = 0.72) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(img.naturalWidth  * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // ── Preview ──
  document.getElementById('previewBtn').addEventListener('click', async () => {
    const getChecked = (groupId) =>
      [...document.querySelectorAll(`#${groupId} input:checked`)].map(c => c.value);
    const leaseTerms = [...document.querySelectorAll('#step2 .checkbox-group input:checked')].map(c => c.value);

    const rawPreviews = pendingPreviews.slice(0, 5);
    const previewPhotos = await Promise.all(rawPreviews.map(url => _compressForPreview(url)));

    const previewData = {
      title:             v('title') || 'Untitled Listing',
      property_type:     v('propertyType'),
      address:           v('address'),
      city:              v('city'),
      state:             v('state'),
      zip:               v('zip'),
      bedrooms:          v('bedrooms') ? parseInt(v('bedrooms')) : null,
      bathrooms:         v('bathrooms') ? parseFloat(v('bathrooms')) : null,
      square_footage:    v('sqft') ? parseInt(v('sqft')) : null,
      monthly_rent:      v('rent') ? parseInt(v('rent')) : 0,
      security_deposit:  v('deposit') ? parseInt(v('deposit')) : null,
      available_date:    v('availDate') || null,
      application_fee:   v('appFee') !== null && v('appFee') !== '' ? parseInt(v('appFee')) : 0,
      lease_terms:       leaseTerms,
      pets_allowed:      document.querySelector('input[name="pets"]:checked')?.value === 'true',
      pet_details:       v('petDetails') || null,
      parking:           v('parking') || null,
      utilities_included: getChecked('utilitiesGroup'),
      amenities:         getChecked('amenitiesGroup'),
      description:       v('description'),
      showing_instructions: v('showingInstructions') || null,
      photo_urls:        previewPhotos,
      status:            'preview',
      landlords:         { contact_name: profile.contact_name, business_name: profile.business_name, tagline: profile.tagline, avatar_url: profile.avatar_url, verified: profile.verified },
    };
    try {
      sessionStorage.setItem('cp_listing_preview', JSON.stringify(previewData));
    } catch (e) {
      previewData.photo_urls = previewPhotos.slice(0, 1);
      try { sessionStorage.setItem('cp_listing_preview', JSON.stringify(previewData)); }
      catch (_) { CP.UI.toast('Preview unavailable — your browser storage is full. Try clearing site data.', 'error'); return; }
    }
    window.location.href = '/property.html?preview=true';
  });

  // Pets toggle
  document.querySelectorAll('input[name="pets"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('petDetailsWrap').style.display =
        document.querySelector('input[name="pets"]:checked')?.value === 'true' ? '' : 'none';
    });
  });

  // Description counter
  document.getElementById('description').addEventListener('input', e => {
    document.getElementById('descCount').textContent = e.target.value.length;
  });

  // ── Photo upload ──
  const dropzone = document.getElementById('photoDropzone');
  const photoInput = document.getElementById('photoInput');

  dropzone.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('click', e => e.stopPropagation());
  photoInput.addEventListener('change', e => handleFiles([...e.target.files]));
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    handleFiles([...e.dataTransfer.files]);
  });

  // H-9: HEIC -> JPEG conversion is asynchronous (heic2any decodes via
  // libheif in a Web Worker), so handleFiles is now async. Each file is
  // processed in sequence to keep iPhone memory pressure low and to
  // preserve the original drop order in the preview grid.
  async function handleFiles(files) {
    const MAX_PHOTOS = 40;
    const HEIC_MIME = /^image\/(heic|heif|heic-sequence|heif-sequence)$/i;
    const HEIC_NAME = /\.(heic|heif)$/i;

    for (const original of files) {
      let file = original;
      const looksHeic =
        HEIC_MIME.test((file.type || '').toLowerCase()) || HEIC_NAME.test(file.name);

      if (looksHeic) {
        if (typeof window.heic2any !== 'function') {
          err(`HEIC converter is still loading — please try "${file.name}" again in a moment.`);
          continue;
        }
        try {
          const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
          const blob = Array.isArray(out) ? out[0] : out;
          const newName = file.name.replace(HEIC_NAME, '') + '.jpg';
          file = new File([blob], newName, { type: 'image/jpeg', lastModified: Date.now() });
        } catch (e) {
          console.error('HEIC conversion failed', e);
          err(`Couldn't convert "${original.name}" from HEIC. Try saving it as JPG on your phone and re-upload.`);
          continue;
        }
      } else if (!file.type.startsWith('image/')) {
        continue;
      }

      if (file.size > 10 * 1024 * 1024) {
        err(`"${file.name}" is too large (${fmtSize(file.size)}). Maximum photo size is 10 MB.`);
        continue;
      }
      if (pendingFiles.length >= MAX_PHOTOS) { err(`Maximum ${MAX_PHOTOS} photos allowed.`); continue; }
      if (pendingFiles.find(f => f.name === file.name && f.size === file.size)) continue;

      pendingFiles.push(file);
      const dataUri = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Read failed'));
        reader.readAsDataURL(file);
      }).catch(() => null);
      if (dataUri) addPhotoPreview(dataUri, file);
      // Issue #14b: kick off the ImageKit upload in the background. The
      // grid re-renders with a "ready" check (or "failed — retry") badge
      // when the upload settles, and autosaveDraft() is called on
      // success so the URL is persisted to localStorage.
      kickPhotoUpload(pendingFiles.length - 1);
    }
    photoInput.value = '';
  }

  function fmtSize(bytes) {
    return bytes >= 1_048_576 ? (bytes / 1_048_576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }

  function renderPhotoGrid() {
    const grid = document.getElementById('photoPreviewGrid');
    grid.innerHTML = '';
    pendingFiles.forEach((file, i) => {
      const u = uploads[i];
      const item = document.createElement('div');
      item.className = 'photo-preview-item' + (i === 0 ? ' is-cover' : '');
      // Issue #14b: per-photo upload status overlay.
      let statusBadge = '';
      if (u?.status === 'uploading') {
        statusBadge =
          `<div style="position:absolute;inset:0;background:rgba(0,0,0,.45);` +
          `display:flex;align-items:center;justify-content:center;color:#fff;` +
          `font-size:.72rem;font-weight:600;border-radius:inherit">Uploading…</div>`;
      } else if (u?.status === 'error') {
        const safeErr = String(u.error || 'Upload failed').replace(/"/g, '&quot;');
        statusBadge =
          `<div class="photo-upload-retry" title="${safeErr}" ` +
          `style="position:absolute;inset:0;background:rgba(220,38,38,.85);` +
          `display:flex;align-items:center;justify-content:center;color:#fff;` +
          `font-size:.7rem;font-weight:600;border-radius:inherit;cursor:pointer;` +
          `text-align:center;padding:6px">⚠ Upload failed<br>(click to retry)</div>`;
      } else if (u?.status === 'ready') {
        statusBadge =
          `<div title="Uploaded" style="position:absolute;top:6px;left:6px;` +
          `background:#16a34a;color:#fff;border-radius:50%;width:20px;height:20px;` +
          `display:flex;align-items:center;justify-content:center;font-size:.66rem;` +
          `font-weight:700">✓</div>`;
      }
      item.innerHTML = `
        <img src="${pendingPreviews[i]}" alt="Preview" loading="lazy">
        ${i === 0 ? '<div class="new-cover-label">Cover</div>' : ''}
        <div class="photo-size-badge">${fmtSize(file.size)}</div>
        ${statusBadge}
        <div class="photo-action-bar">
          ${i !== 0 ? `<button class="photo-action-btn new-cover-btn" title="Set as cover" type="button">★</button>` : ''}
          <button class="photo-action-btn new-delete-btn" title="Remove" type="button">✕</button>
        </div>`;
      if (i !== 0) {
        item.querySelector('.new-cover-btn').addEventListener('click', () => {
          pendingFiles.unshift(pendingFiles.splice(i, 1)[0]);
          pendingPreviews.unshift(pendingPreviews.splice(i, 1)[0]);
          uploads.unshift(uploads.splice(i, 1)[0]);
          renderPhotoGrid();
          autosaveDraft();
          CP.UI.toast('Cover photo updated.', 'success');
        });
      }
      // Issue #14b: retry click on a failed upload re-runs kickPhotoUpload.
      const retryEl = item.querySelector('.photo-upload-retry');
      if (retryEl) {
        retryEl.addEventListener('click', () => kickPhotoUpload(i));
      }
      item.querySelector('.new-delete-btn').addEventListener('click', async () => {
        // Best-effort: remove the file from ImageKit if it was already uploaded.
        if (u && u.status === 'ready' && u.fileId &&
            CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
          try {
            const accessToken = await window.CP?.Auth?.getAccessToken?.();
            if (accessToken) {
              deleteFromImageKit(u.fileId, {
                supabaseUrl: CONFIG.SUPABASE_URL,
                anonKey:     CONFIG.SUPABASE_ANON_KEY,
                userToken:   accessToken,
              }).catch(e => console.warn('cleanup delete failed:', e));
            }
          } catch (e) { console.warn('cleanup token fetch failed:', e); }
        }
        pendingFiles.splice(i, 1);
        pendingPreviews.splice(i, 1);
        uploads.splice(i, 1);
        renderPhotoGrid();
        autosaveDraft();
      });
      grid.appendChild(item);
    });
  }

  function addPhotoPreview(src, file) {
    pendingPreviews.push(src);
    renderPhotoGrid();
  }

  // ── Step navigation ──
  function goTo(step) {
    document.querySelector(`#step${currentStep}`).classList.remove('active');
    document.querySelector(`#step${step}`).classList.add('active');
    document.querySelectorAll('.listing-step').forEach(s => {
      const n = parseInt(s.dataset.step);
      s.classList.remove('active', 'completed');
      if (n === step) s.classList.add('active');
      else if (n < step) s.classList.add('completed');
    });
    if (step === 6) buildReview();
    currentStep = step;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Validation ──
  function validate1() {
    if (!v('title')) return err('Please enter a listing title.');
    if (v('title').length > 120) return err('Title must be 120 characters or less.');
    if (!v('propertyType')) return err('Please select a property type.');
    if (!v('address')) return err('Please enter the property address.');
    if (!v('city'))    return err('Please enter the city.');
    if (!v('state'))   return err('Please select a state.');
    if (!v('zip'))     return err('Please enter the ZIP code.');
    if (!/^\d{5}(-\d{4})?$/.test(v('zip'))) return err('Please enter a valid ZIP code (e.g. 90210).');
    return true;
  }
  function validate2() {
    if (!v('bedrooms')) return err('Please select number of bedrooms.');
    if (!v('bathrooms')) return err('Please select number of bathrooms.');
    if (!v('rent') || parseInt(v('rent')) < 1) return err('Please enter a valid monthly rent.');
    if (parseInt(v('rent')) > 50000) return err('Monthly rent looks too high — please double-check.');
    return true;
  }
  function validate3() {
    const petsAllowed = document.querySelector('input[name="pets"]:checked')?.value === 'true';
    if (petsAllowed && !v('petDetails')) return err('Please describe your pet policy (breeds, weight limits, deposit, etc.).');
    return true;
  }
  function validatePhotos() {
    // Issue #14b: gate progression on the actual upload state, not just
    // on how many files are sitting in the picker. Photos still in flight
    // would be lost on submit.
    const inflight = uploads.filter(u => u?.status === 'uploading').length;
    const ready    = uploads.filter(u => u?.status === 'ready').length;
    const failed   = uploads.filter(u => u?.status === 'error').length;
    if (pendingFiles.length < 3) return err('Please upload at least 3 photos.');
    if (inflight > 0) {
      return err(`${inflight} photo${inflight !== 1 ? 's are' : ' is'} still uploading — please wait a moment.`);
    }
    if (ready < 3) {
      const msg = failed > 0
        ? `Only ${ready} photo${ready !== 1 ? 's' : ''} uploaded successfully (${failed} failed). Please retry the failed photos or remove them.`
        : `Only ${ready} photo${ready !== 1 ? 's' : ''} uploaded — at least 3 are required.`;
      return err(msg);
    }
    return true;
  }
  function validate5() {
    if (!v('description') || v('description').length < 50) return err('Please write a description of at least 50 characters.');
    if (v('description').length > 2000) return err('Description must be 2000 characters or fewer.');
    return true;
  }
  function v(id) { return document.getElementById(id)?.value?.trim(); }
  function err(msg) { CP.UI.toast(msg, 'error'); return false; }

  // ── Build review ──
  function buildReview() {
    const leaseTerms = [...document.querySelectorAll('#step2 .checkbox-group input[type=checkbox]:checked')].map(c => c.value);
    const utilities  = [...document.querySelectorAll('#utilitiesGroup input:checked')].map(c => c.value);
    const amenities  = [...document.querySelectorAll('#amenitiesGroup input:checked')].map(c => c.value);
    const petsAllowed = document.querySelector('input[name="pets"]:checked')?.value === 'true';
    const appFee = parseInt(v('appFee')) || 0;

    const row = (label, val) => val ? `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border);font-size:.85rem;gap:var(--sp-3)">
        <span style="color:var(--muted);flex-shrink:0">${label}</span>
        <span style="font-weight:600;color:var(--text);text-align:right">${val}</span>
      </div>` : '';
    const section = (title) => `
      <div style="font-size:.66rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);padding:14px 0 4px;margin-top:4px">${title}</div>`;

    document.getElementById('reviewSummary').innerHTML = `
      ${section('Property')}
      ${row('Title',        v('title'))}
      ${row('Type',         v('propertyType') ? v('propertyType').charAt(0).toUpperCase() + v('propertyType').slice(1) : null)}
      ${row('Address',      `${v('address')}, ${v('city')}, ${v('state')} ${v('zip')}`)}
      ${section('Details & Pricing')}
      ${row('Bedrooms',     v('bedrooms') === '0' ? 'Studio' : v('bedrooms'))}
      ${row('Bathrooms',    v('bathrooms'))}
      ${row('Sq. Footage',  v('sqft') ? `${parseInt(v('sqft')).toLocaleString()} sqft` : null)}
      ${row('Monthly Rent', `$${parseInt(v('rent')).toLocaleString()}`)}
      ${row('Deposit',      v('deposit') ? `$${parseInt(v('deposit')).toLocaleString()}` : 'Not specified')}
      ${row('Available',    v('availDate') || 'Immediately')}
      ${row('Lease Terms',  leaseTerms.length ? leaseTerms.join(', ') : null)}
      ${row('App. Fee',     appFee > 0 ? `$${appFee}` : '$50')}
      ${section('Features & Policies')}
      ${row('Pets',         petsAllowed ? (v('petDetails') || 'Allowed') : 'No Pets')}
      ${row('Parking',      v('parking') || null)}
      ${row('Utilities',    utilities.length ? utilities.join(', ') : 'None included')}
      ${row('Amenities',    amenities.length ? amenities.join(', ') : null)}
      ${section('Photos & Description')}
      ${row('Photos',       `${pendingFiles.length} photo${pendingFiles.length !== 1 ? 's' : ''} ready to upload`)}
      ${row('Showing',      v('showingInstructions') || null)}
    `;
  }

  // ── Submit ──
  async function submitListing() {
    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';

    if (_geocodePromise) await _geocodePromise;

    if (!propId) propId = localStorage.getItem('cp_draft_propid');
    if (!propId) {
      const { data: rpcId, error: rpcErr } = await CP.sb().rpc('generate_property_id');
      if (rpcErr || !rpcId) {
        CP.UI.toast('Failed to initialize listing. Please refresh and try again.', 'error');
        btn.disabled = false; btn.textContent = 'Submit Listing';
        return;
      }
      propId = rpcId;
      localStorage.setItem('cp_draft_propid', propId);
    }

    // Duplicate detection
    const { data: dupes } = await CP.sb()
      .from('properties')
      .select('id, title, status')
      .eq('landlord_id', profile.id)
      .ilike('address', v('address'))
      .ilike('city', v('city'))
      .not('status', 'eq', 'archived')
      .limit(1);

    if (dupes && dupes.length > 0) {
      const existing = dupes[0];
      const proceed = await CP.UI.cpConfirm(
        `A listing for this address already exists: "${existing.title}" (${existing.status}). Do you want to create another listing at the same address?`
      );
      if (!proceed) { btn.disabled = false; btn.textContent = 'Submit Listing'; return; }
    }

    btn.textContent = 'Saving listing…';

    const getChecked = (groupId) =>
      [...document.querySelectorAll(`#${groupId} input:checked`)].map(c => c.value);
    const leaseTerms = [...document.querySelectorAll('#step2 .checkbox-group input:checked')].map(c => c.value);

    const listingData = {
      id               : propId,
      landlord_id      : profile.id,
      status           : 'active',
      title            : v('title'),
      property_type    : v('propertyType'),
      address          : v('address'),
      city             : v('city'),
      state            : v('state'),
      zip              : v('zip'),
      lat              : geocodedLat,
      lng              : geocodedLng,
      bedrooms         : v('bedrooms') ? parseInt(v('bedrooms')) : null,
      bathrooms        : v('bathrooms') ? parseFloat(v('bathrooms')) : null,
      square_footage   : v('sqft') ? parseInt(v('sqft')) : null,
      monthly_rent     : parseInt(v('rent')),
      security_deposit : v('deposit') ? parseInt(v('deposit')) : null,
      last_months_rent : v('lastMonthRent') ? parseInt(v('lastMonthRent')) : null,
      admin_fee        : v('adminFee') ? parseInt(v('adminFee')) : null,
      move_in_special  : v('moveInSpecial') || null,
      available_date   : v('availDate') || null,
      application_fee  : v('appFee') !== null && v('appFee') !== '' ? parseInt(v('appFee')) : 0,
      minimum_lease_months: null,
      lease_terms      : leaseTerms,
      pets_allowed     : document.querySelector('input[name="pets"]:checked')?.value === 'true',
      pet_types_allowed: document.querySelector('input[name="pets"]:checked')?.value === 'true'
                           ? [...document.querySelectorAll('#petTypesGroup input:checked')].map(c => c.value)
                           : [],
      pet_weight_limit : v('petWeightLimit') ? parseInt(v('petWeightLimit')) : null,
      pet_deposit      : v('petDeposit') ? parseInt(v('petDeposit')) : null,
      pet_details      : v('petDetails') || null,
      parking          : v('parking') || null,
      garage_spaces    : v('garageSpaces') ? parseInt(v('garageSpaces')) : null,
      parking_fee      : v('parkingFee') ? parseInt(v('parkingFee')) : null,
      utilities_included: getChecked('utilitiesGroup'),
      amenities        : getChecked('amenitiesGroup'),
      laundry_type     : v('laundryType') || null,
      heating_type     : v('heatingType') || null,
      cooling_type     : v('coolingType') || null,
      description      : v('description'),
      showing_instructions: v('showingInstructions') || null,
      minimum_income_multiplier: v('minIncome') ? parseFloat(v('minIncome')) : null,
      minimum_credit_score     : v('minCredit') ? parseInt(v('minCredit')) : null,
    };


    const { error } = await CP.sb().from('properties').insert(listingData);

    if (error) {
      if (error.code === '23505') {
        localStorage.removeItem('cp_draft_propid');
        localStorage.removeItem('cp_draft_s1');
        sessionStorage.removeItem('cp_draft_photo_token'); // Issue #14b
        CP.UI.toast('A conflict was detected. Please refresh the page and resubmit.', 'error');
      } else {
        CP.UI.toast('Failed to save listing. Please try again.', 'error');
      }
      btn.disabled = false; btn.textContent = 'Submit Listing';
      return;
    }

    // Issue #14b: photos are uploaded to ImageKit as the landlord adds them
    // (kickPhotoUpload), so by the time we get here most/all are already in
    // the CDN. We just need to wait for any in-flight uploads to settle and
    // then commit the URLs to property_photos via add_property_photo (which
    // handles the ownership check and assigns display_order).
    if (uploads.length) {
      const inflight = uploads.filter(u => u?.status === 'uploading');
      if (inflight.length) {
        btn.textContent = `Waiting on ${inflight.length} upload${inflight.length !== 1 ? 's' : ''}…`;
        await Promise.allSettled(inflight.map(u => u._promise).filter(Boolean));
      }
      const ready  = uploads.filter(u => u?.status === 'ready');
      const failed = uploads.filter(u => u?.status === 'error').length;
      if (ready.length) {
        btn.textContent = `Saving photos… (0/${ready.length})`;
        let done = 0;
        for (const u of ready) {
          try {
            const { error: phErr } = await supabase.rpc('add_property_photo', {
              p_property_id: propId,
              p_url:         u.url,
              p_file_id:     u.fileId || '',
            });
            if (phErr) {
              console.warn('add_property_photo failed for', u.url, phErr);
            }
          } catch (rpcErr) {
            console.warn('add_property_photo threw for', u.url, rpcErr);
          }
          done++;
          btn.textContent = `Saving photos… (${done}/${ready.length})`;
        }
      } else if (!failed) {
        // No ready photos and no failures — should not happen because we
        // gate validation on ready ≥ 3, but log just in case.
        console.warn('Submit reached photo step with no ready or failed photos.');
      }
      if (failed > 0) {
        CP.UI.toast(
          `Listing saved. ${failed} photo${failed !== 1 ? 's' : ''} had upload errors. You can retry from Edit Listing.`,
          'info'
        );
      }
    }

    // Success screen
    document.querySelector('.listing-form-card').innerHTML = `
      <div style="text-align:center;padding:var(--sp-7) var(--sp-4)">
        <div style="width:70px;height:70px;background:#f0fdf4;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto var(--sp-4);font-size:32px;color:#16a34a;font-weight:700">✓</div>
        <h2 style="font-size:1.7rem;color:var(--text);margin-bottom:var(--sp-2);font-weight:700">Your Listing is Live!</h2>
        <p style="color:var(--muted);font-size:.9rem;max-width:420px;margin:0 auto var(--sp-4);line-height:1.65">
          <strong>${v('title')}</strong> is now <strong>active</strong> and immediately visible to renters searching on Choice Properties.
        </p>

        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:var(--r-md);padding:var(--sp-4);max-width:440px;margin:0 auto var(--sp-4);text-align:left">
          <div style="font-weight:700;font-size:.85rem;color:#166534;margin-bottom:10px">✓ What happens next</div>
          <div style="display:flex;flex-direction:column;gap:10px;font-size:.78rem;color:#14532d">
            <div style="display:flex;gap:10px"><div style="width:22px;height:22px;background:#16a34a;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.66rem;font-weight:700;color:#fff;flex-shrink:0">1</div><span>Your listing is <strong>live now</strong> and appearing in search results.</span></div>
            <div style="display:flex;gap:10px"><div style="width:22px;height:22px;background:#16a34a;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.66rem;font-weight:700;color:#fff;flex-shrink:0">2</div><span>Interested tenants can send <strong>inquiries</strong> or <strong>submit applications</strong> right away.</span></div>
            <div style="display:flex;gap:10px"><div style="width:22px;height:22px;background:#16a34a;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.66rem;font-weight:700;color:#fff;flex-shrink:0">3</div><span>Manage your listing from your <strong>Landlord Dashboard</strong>.</span></div>
          </div>
        </div>

        <p style="font-size:.72rem;color:var(--muted);margin-bottom:var(--sp-4)">
          Listing ID: <strong style="font-family:monospace">${propId}</strong>
        </p>
        <div style="display:flex;gap:var(--sp-2);justify-content:center;flex-wrap:wrap">
          <a href="/landlord/dashboard.html" class="btn btn-primary" id="successDashBtn">← Back to Dashboard</a>
          <a href="/landlord/new-listing.html" class="btn btn-ghost" id="successNewBtn">Add Another Listing</a>
        </div>
      </div>`;

    _draftDirty = false;
    localStorage.removeItem('cp_draft_propid');
    localStorage.removeItem('cp_draft_s1');
    sessionStorage.removeItem('cp_draft_photo_token'); // Issue #14b
    sessionStorage.removeItem('cp_listing_preview');

    let redirectTimer = setTimeout(() => { window.location.href = '/landlord/dashboard.html'; }, 8000);
    document.getElementById('successDashBtn')?.addEventListener('click', () => clearTimeout(redirectTimer));
    document.getElementById('successNewBtn')?.addEventListener('click', () => clearTimeout(redirectTimer));
  }


