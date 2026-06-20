// js/landlord/edit-listing.js
  // Extracted from landlord/edit-listing.html (issue #27). Loaded as <script type="module">.
  // Single-page edit form: load existing, photo add/remove, save changes.
  // Imports use absolute /js/... paths because the file lives in /js/landlord/.

    import { requireAuth, getLandlordProfile, signOut, supabase } from '/js/cp-api.js';
  import { uploadMultipleToImageKit, deleteFromImageKit } from '/js/imagekit.js';
  import { STATES, whenSidebarReady, installImageFallback } from '/js/landlord/shared.js';

  installImageFallback();

  const _params  = new URLSearchParams(window.location.search);
  const _isAdmin = _params.get('admin') === '1';

  if (_isAdmin) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { window.location.href = '/admin/login.html'; throw new Error(); }
    const { data: adminRole } = await supabase.from('admin_roles').select('id').eq('user_id', user.id).maybeSingle();
    if (!adminRole) { window.location.href = '/admin/login.html'; throw new Error(); }
  } else {
    await requireAuth('/landlord/login.html');
  }

  const profile = await getLandlordProfile();
  if (!profile && !_isAdmin) { window.location.href = '/landlord/login.html'; throw new Error(); }

  // Wire chrome's sign-out (delegated)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="sign-out"]');
    if (btn) {
      e.preventDefault();
      supabase.auth.signOut().then(() => {
        window.location.href = _isAdmin ? '/admin/login.html' : '/landlord/login.html';
      });
    }
  });

  // Sidebar info via chrome
  whenSidebarReady(() => {
    const nameEl = document.getElementById('admin-name');
    if (nameEl) {
      if (profile) {
        const display = profile.business_name || profile.contact_name || '';
        nameEl.textContent = display + (profile.email ? ' · ' + profile.email : '');
      } else if (_isAdmin) {
        nameEl.textContent = 'Admin · (admin session)';
      }
    }
  });

  const propertyId = _params.get('id');
  const backURL    = _isAdmin ? '/admin/listings.html' : '/landlord/dashboard.html';
  if (!propertyId) { window.location.href = backURL; throw new Error(); }

  const { data: prop, error } = await supabase
    .from('properties').select('*, property_photos(url, file_id, display_order)').eq('id', propertyId).single();

  // Phase 3c: derive legacy photo_urls / photo_file_ids from the embedded property_photos.
  if (prop) {
    const _photos = Array.isArray(prop.property_photos) ? prop.property_photos.slice() : [];
    _photos.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    prop.photo_urls     = _photos.map(x => x.url).filter(Boolean);
    prop.photo_file_ids = _photos.map(x => x.file_id ?? null);
  }

  if (error || !prop) {
    CP.UI.toast('Property not found or access denied.', 'error');
    setTimeout(() => window.location.href = backURL, 2000);
    throw new Error();
  }

  document.getElementById('pageTitle').textContent = prop.title;
  document.getElementById('viewPropBtn').href      = `/property.html?id=${propertyId}`;

  // Photo state
  let currentPhotoUrls    = [...(prop.photo_urls    || [])];
  let currentPhotoFileIds = [...(prop.photo_file_ids || [])];
  let originalPhotoFileIds = [...currentPhotoFileIds];
  let pendingNewFiles     = [];

  const chk = (arr, val) => arr && arr.includes(val) ? 'checked' : '';
  const sel = (opt, val) => opt == val ? 'selected' : '';
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // STATES imported from shared.js

  document.getElementById('formCard').innerHTML = `
    <div class="form-section">

      <div class="form-section-title">Basic Information</div>
      <div class="form-group">
        <label class="form-label" for="title">Listing Title *</label>
        <input type="text" class="form-input" id="title" value="${esc(prop.title)}">
      </div>
      <div class="form-group">
        <label class="form-label" for="propertyType">Property Type *</label>
        <select class="form-select" id="propertyType">
          <option value="apartment" ${sel(prop.property_type,'apartment')}>Apartment</option>
          <option value="house"     ${sel(prop.property_type,'house')}>House</option>
          <option value="condo"     ${sel(prop.property_type,'condo')}>Condo</option>
          <option value="townhouse" ${sel(prop.property_type,'townhouse')}>Townhouse</option>
          <option value="duplex"    ${sel(prop.property_type,'duplex')}>Duplex</option>
          <option value="studio"    ${sel(prop.property_type,'studio')}>Studio</option>
          <option value="basement"  ${sel(prop.property_type,'basement')}>Basement Unit</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="address">Street Address *</label>
        <input type="text" class="form-input" id="address" value="${esc(prop.address)}">
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label" for="city">City *</label><input type="text" class="form-input" id="city" value="${esc(prop.city)}"></div>
        <div class="form-group">
          <label class="form-label" for="state">State *</label>
          <select class="form-select" id="state" required>
            <option value="">Select State</option>
            ${STATES.map(([c,n]) => `<option value="${c}" ${sel(prop.state,c)}>${n}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label class="form-label" for="zip">ZIP</label><input type="text" class="form-input" id="zip" value="${esc(prop.zip||'')}"></div>
      </div>

      <hr style="border:none;border-top:1px solid var(--border);margin:var(--sp-5) 0">
      <div class="form-section-title">Details &amp; Pricing</div>
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label" for="bedrooms">Bedrooms *</label>
          <select class="form-select" id="bedrooms">
            <option value="0" ${sel(prop.bedrooms,0)}>Studio</option>
            <option value="1" ${sel(prop.bedrooms,1)}>1</option>
            <option value="2" ${sel(prop.bedrooms,2)}>2</option>
            <option value="3" ${sel(prop.bedrooms,3)}>3</option>
            <option value="4" ${sel(prop.bedrooms,4)}>4</option>
            <option value="5" ${sel(prop.bedrooms,5)}>5+</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="bathrooms">Bathrooms *</label>
          <select class="form-select" id="bathrooms">
            <option value="1"   ${sel(prop.bathrooms,1)}>1</option>
            <option value="1.5" ${sel(prop.bathrooms,1.5)}>1.5</option>
            <option value="2"   ${sel(prop.bathrooms,2)}>2</option>
            <option value="2.5" ${sel(prop.bathrooms,2.5)}>2.5</option>
            <option value="3"   ${sel(prop.bathrooms,3)}>3+</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label" for="sqft">Sq. Footage</label><input type="number" class="form-input" id="sqft" value="${prop.square_footage||''}"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label" for="rent">Monthly Rent *</label>
          <div style="position:relative"><span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted)">$</span><input type="number" class="form-input" id="rent" value="${prop.monthly_rent}" style="padding-left:28px"></div>
        </div>
        <div class="form-group">
          <label class="form-label" for="deposit">Security Deposit</label>
          <div style="position:relative"><span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted)">$</span><input type="number" class="form-input" id="deposit" value="${prop.security_deposit||''}" style="padding-left:28px"></div>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label" for="availDate">Available Date</label><input type="date" class="form-input" id="availDate" value="${prop.available_date||''}"></div>
        <div class="form-group">
          <label class="form-label" for="appFee">Application Fee</label>
          <div style="position:relative"><span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted)">$</span><input type="number" class="form-input" id="appFee" value="${prop.application_fee ?? 50}" style="padding-left:28px" min="0" placeholder="50"></div>
          <div class="form-hint">Standard application fee is $50.</div>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label" for="lastMonthRent">Last Month's Rent</label>
          <div style="position:relative"><span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted)">$</span><input type="number" class="form-input" id="lastMonthRent" value="${prop.last_months_rent||''}" style="padding-left:28px" min="0" placeholder="0"></div>
          <div class="form-hint">Enter 0 if not required.</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="adminFee">Admin / Move-in Fee</label>
          <div style="position:relative"><span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted)">$</span><input type="number" class="form-input" id="adminFee" value="${prop.admin_fee||''}" style="padding-left:28px" min="0" placeholder="0"></div>
          <div class="form-hint">One-time fee at move-in. Enter 0 if none.</div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="moveInSpecial">Move-in Special <span class="muted">(optional)</span></label>
        <input type="text" class="form-input" id="moveInSpecial" value="${esc(prop.move_in_special||'')}" placeholder="e.g. First month free, Reduced deposit" maxlength="200">
        <div class="form-hint">Highlight any current promotions.</div>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label" for="minIncome">Income Requirement <span class="muted">(optional)</span></label>
          <select class="form-select" id="minIncome">
            <option value="">No minimum</option>
            ${[['2','2× monthly rent'],['2.5','2.5× monthly rent'],['3','3× monthly rent'],['3.5','3.5× monthly rent'],['4','4× monthly rent']].map(([vv,l])=>`<option value="${vv}" ${prop.minimum_income_multiplier==vv?'selected':''}>${l}</option>`).join('')}
          </select>
          <div class="form-hint">Standard is 2.5–3×.</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="minCredit">Min. Credit Score <span class="muted">(optional)</span></label>
          <select class="form-select" id="minCredit">
            <option value="">No minimum</option>
            ${[580,620,640,660,680,700,720,750].map(s=>`<option value="${s}" ${prop.minimum_credit_score==s?'selected':''}>${s}</option>`).join('')}
          </select>
          <div class="form-hint">Helps applicants self-screen.</div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="status">Listing Status</label>
        <select class="form-select" id="status">
          ${prop.status === 'draft' ? `<option value="draft" selected>Draft — not yet submitted</option>` : ''}
          <option value="active" ${sel(prop.status,'active')}>Active — visible to renters</option>
          <option value="paused" ${sel(prop.status,'paused')}>Paused — hidden from search</option>
          <option value="rented" ${sel(prop.status,'rented')}>Rented — unit is occupied</option>
        </select>
        <div class="form-hint">${prop.status === 'draft' ? 'Change to "Active" to publish this listing.' : 'Set to "Paused" to hide from search, or "Rented" once leased.'}</div>
      </div>

      <hr style="border:none;border-top:1px solid var(--border);margin:var(--sp-5) 0">
      <div class="form-section-title">Features &amp; Policies</div>

      <div class="form-group">
        <label class="form-label">Pets</label>
        <div style="display:flex;gap:var(--sp-2)">
          <label class="checkbox-pill" style="flex:1;justify-content:center"><input type="radio" name="pets" value="true" ${prop.pets_allowed?'checked':''}> Pets Allowed</label>
          <label class="checkbox-pill" style="flex:1;justify-content:center"><input type="radio" name="pets" value="false" ${!prop.pets_allowed?'checked':''}> No Pets</label>
        </div>
        <div id="petDetailsWrap" style="${prop.pets_allowed?'':'display:none'};margin-top:var(--sp-3)">
          <div class="form-group">
            <label class="form-label" style="font-size:.78rem">Pet Types Allowed</label>
            <div class="checkbox-group" id="petTypesGroup">
              ${['Dogs','Cats','Birds','Small Animals','Reptiles'].map(t=>`<label class="checkbox-pill"><input type="checkbox" name="petTypes" value="${t}" ${chk(prop.pet_types_allowed,t)}> ${t}</label>`).join('')}
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label" style="font-size:.78rem">Dog Weight Limit</label>
              <select class="form-select" id="petWeightLimit">
                <option value="">No limit</option>
                ${[15,25,50,75,100].map(w=>`<option value="${w}" ${prop.pet_weight_limit==w?'selected':''}>Under ${w} lbs</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" style="font-size:.78rem">Pet Deposit</label>
              <div style="position:relative"><span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted)">$</span><input type="number" class="form-input" id="petDeposit" value="${prop.pet_deposit||''}" style="padding-left:28px" min="0" placeholder="0"></div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size:.78rem">Additional Pet Notes</label>
            <input type="text" class="form-input" id="petDetails" value="${esc(prop.pet_details||'')}" placeholder="e.g. Max 2 pets, breed restrictions apply">
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="parking">Parking Type</label>
        <select class="form-select" id="parking">
          <option value="">Select parking type</option>
          ${['None','Street','Driveway','Parking lot','Covered','Garage','Detached Garage','Gated'].map(p=>`<option value="${p}" ${sel(prop.parking,p)}>${p === 'None' ? 'No Parking Available' : p === 'Street' ? 'Street Parking Only' : p === 'Garage' ? 'Garage (Attached)' : p === 'Detached Garage' ? 'Garage (Detached)' : p === 'Parking lot' ? 'Parking Lot' : p}</option>`).join('')}
        </select>
      </div>

      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label" for="garageSpaces">Spaces Included</label>
          <select class="form-select" id="garageSpaces">
            <option value="">Select</option>
            ${[0,1,2,3,4].map(n=>`<option value="${n}" ${prop.garage_spaces==n?'selected':''}>${n === 4 ? '4+ spaces' : n === 0 ? '0 (none)' : n + ' space' + (n>1?'s':'')}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="parkingFee">Monthly Parking Fee</label>
          <div style="position:relative"><span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted)">$</span><input type="number" class="form-input" id="parkingFee" value="${prop.parking_fee||''}" style="padding-left:28px" min="0" placeholder="0"></div>
          <div class="form-hint">Enter 0 if included in rent.</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="evCharging">EV Charging</label>
          <select class="form-select" id="evCharging">
            <option value="none" ${!prop.ev_charging||prop.ev_charging==='none'?'selected':''}>Not Available</option>
            <option value="available" ${prop.ev_charging==='available'?'selected':''}>Available (Level 1/2)</option>
            <option value="included" ${prop.ev_charging==='included'?'selected':''}>Included in Rent</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Utilities Included</label>
        <div class="checkbox-group">
          ${['Water','Gas','Electric','Trash','Internet','Heat'].map(u=>`<label class="checkbox-pill"><input type="checkbox" name="utilities" value="${u}" ${chk(prop.utilities_included,u)}> ${u}</label>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Amenities</label>
        <div class="checkbox-group">
          ${['Washer/Dryer','Dishwasher','Central A/C','Hardwood Floors','Balcony/Patio','Basement','Pool','Gym','Fireplace','Stainless Appliances','Granite Counters','Smart Home'].map(a=>`<label class="checkbox-pill"><input type="checkbox" name="amenities" value="${a}" ${chk(prop.amenities,a)}> ${a}</label>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Lease Terms</label>
        <div class="checkbox-group">
          ${['Month-to-month','6 months','12 months','24 months'].map(t=>`<label class="checkbox-pill"><input type="checkbox" name="leaseTerms" value="${t}" ${chk(prop.lease_terms,t)}> ${t}</label>`).join('')}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="laundryType">Laundry</label>
        <select class="form-select" id="laundryType">
          <option value="" ${!prop.laundry_type?'selected':''}>Select laundry situation</option>
          ${[
            ['In-unit washer/dryer','In-unit washer/dryer included'],
            ['Hookups only','Washer/dryer hookups only (tenant brings)'],
            ['Shared laundry','Shared laundry on-site'],
            ['Laundromat nearby','No on-site laundry (laundromat nearby)'],
            ['None','No laundry facilities']
          ].map(([v,l])=>`<option value="${v}" ${prop.laundry_type===v?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label" for="heatingType">Heating</label>
          <select class="form-select" id="heatingType">
            <option value="" ${!prop.heating_type?'selected':''}>Select heating type</option>
            ${[
              ['Forced air (gas)','Forced air — gas'],
              ['Forced air (electric)','Forced air — electric'],
              ['Baseboard electric','Baseboard electric'],
              ['Radiant/in-floor','Radiant / in-floor'],
              ['Heat pump','Heat pump'],
              ['Boiler/radiator','Boiler / radiator'],
              ['Other','Other']
            ].map(([v,l])=>`<option value="${v}" ${prop.heating_type===v?'selected':''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="coolingType">Cooling / A/C</label>
          <select class="form-select" id="coolingType">
            <option value="" ${!prop.cooling_type?'selected':''}>Select cooling type</option>
            ${[
              ['Central A/C','Central A/C'],
              ['Mini-split','Mini-split (ductless)'],
              ['Window units','Window units'],
              ['Evaporative cooler','Evaporative cooler'],
              ['None','No A/C']
            ].map(([v,l])=>`<option value="${v}" ${prop.cooling_type===v?'selected':''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>

      <hr style="border:none;border-top:1px solid var(--border);margin:var(--sp-5) 0">
      <div class="form-section-title">Photos</div>
      <p class="photo-count-hint">
        The first photo is the cover shown in search results. Click ★ to set a new cover or ✕ to remove a photo.
      </p>

      <div class="existing-photos-grid" id="existingPhotosGrid"></div>

      <div class="photo-dropzone" id="photoDropzone" style="margin-bottom:var(--sp-3)">
        <h4>Add more photos</h4>
        <p>Drag &amp; drop or click to browse · JPG, PNG, WEBP</p>
        <input type="file" id="photoInput" multiple accept="image/*" style="opacity:0;position:absolute;width:0;height:0;pointer-events:none;">
      </div>

      <div class="photo-preview-grid" id="newPhotosGrid"></div>

      <div id="uploadProgress" style="display:none;margin-top:var(--sp-3)">
        <div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:6px">
          <span id="uploadStatusText">Uploading…</span>
          <span id="uploadPct">0%</span>
        </div>
        <div class="photo-upload-progress"><div class="photo-upload-bar" id="uploadBar" style="width:0%"></div></div>
      </div>

      <hr style="border:none;border-top:1px solid var(--border);margin:var(--sp-5) 0">
      <div class="form-section-title">Description</div>
      <div class="form-group">
        <label class="form-label" for="description">Property Description *</label>
        <textarea class="form-textarea" id="description" rows="7" style="min-height:160px">${esc(prop.description||'')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label" for="showingInstructions">Showing Instructions</label>
        <input type="text" class="form-input" id="showingInstructions" value="${esc(prop.showing_instructions||'')}" placeholder="e.g. Contact to schedule, lockbox available">
      </div>

      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4);margin-top:var(--sp-4)">
        <h4 style="font-size:.9rem;font-weight:700;color:var(--text);margin:0 0 var(--sp-2)">Listing Attestation</h4>
        <p style="font-size:.82rem;color:var(--muted);margin:0 0 var(--sp-3)">By saving changes, you confirm the following.</p>
        <div style="display:flex;flex-direction:column;gap:var(--sp-2)">
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:.82rem;color:var(--muted);line-height:1.5">
            <input type="checkbox" id="editAttestAccuracy" required style="margin-top:3px;flex-shrink:0">
            <span>The information in this listing is accurate and truthful, and this property is legally available for rent at the listed price.</span>
          </label>
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:.82rem;color:var(--muted);line-height:1.5">
            <input type="checkbox" id="editAttestFairHousing" required style="margin-top:3px;flex-shrink:0">
            <span>I agree to comply with the <a href="/fair-housing.html" target="_blank" style="color:var(--brand)">Fair Housing Act</a> and all applicable fair housing laws.</span>
          </label>
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:.82rem;color:var(--muted);line-height:1.5">
            <input type="checkbox" id="editAttestPolicy" required style="margin-top:3px;flex-shrink:0">
            <span>I agree to the Choice Properties <a href="/terms.html" target="_blank" style="color:var(--brand)">Terms of Service</a> and platform policies.</span>
          </label>
        </div>
      </div>

      <div class="form-nav" style="margin-top:var(--sp-5)">
        <a href="${backURL}" class="btn btn-ghost">← Cancel</a>
        <button class="btn btn-primary btn-lg" id="saveBtn">Save Changes</button>
      </div>

      <div class="danger-zone">
        <div class="danger-zone-title">Danger Zone</div>
        <div class="danger-zone-desc">Permanently delete this listing. All photos and data will be removed and cannot be recovered.</div>
        <button class="btn btn-danger" id="openDeleteBtn">Delete This Listing</button>
      </div>

    </div>`;

  // Pet details toggle
  document.querySelectorAll('input[name="pets"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('petDetailsWrap').style.display =
        document.querySelector('input[name="pets"]:checked')?.value === 'true' ? '' : 'none';
    });
  });

  // ── Photos ──────────────────────────────────────────────
  function renderExistingPhotos() {
    const grid = document.getElementById('existingPhotosGrid');
    if (!currentPhotoUrls.length) {
      grid.innerHTML = `<p style="color:var(--muted);font-size:.82rem;grid-column:1/-1">No photos yet. Add some below.</p>`;
      return;
    }
    grid.innerHTML = currentPhotoUrls.map((url, i) => `
      <div class="existing-photo-item ${i === 0 ? 'is-cover' : ''}" id="epItem-${i}">
        <img src="${url}" alt="Photo ${i+1}" loading="lazy">
        ${i === 0 ? '<div class="cover-label">Cover</div>' : ''}
        <div class="photo-action-bar">
          ${i !== 0 ? `<button class="photo-action-btn cover-btn" title="Set as cover" data-action="set-cover" data-idx="${i}">★</button>` : ''}
          <button class="photo-action-btn delete-btn" title="Remove photo" data-action="remove-photo" data-idx="${i}">✕</button>
        </div>
      </div>`).join('');
  }
  renderExistingPhotos();

  // Set min available date to today
  const _availEl = document.getElementById('availDate');
  if (_availEl) _availEl.min = new Date().toISOString().split('T')[0];

  // Delegated photo actions
  document.getElementById('existingPhotosGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    if (btn.dataset.action === 'set-cover') {
      const url    = currentPhotoUrls.splice(idx, 1)[0];
      const fileId = currentPhotoFileIds.splice(idx, 1)[0] ?? null;
      currentPhotoUrls.unshift(url);
      currentPhotoFileIds.unshift(fileId);
      renderExistingPhotos();
      CP.UI.toast('Cover photo updated.', 'success');
    } else if (btn.dataset.action === 'remove-photo') {
      currentPhotoUrls.splice(idx, 1);
      currentPhotoFileIds.splice(idx, 1);
      renderExistingPhotos();
      CP.UI.toast('Photo removed — save changes to apply.', 'info');
    }
  });

  // ── New photo upload ────────────────────────────────────
  const dropzone   = document.getElementById('photoDropzone');
  const photoInput = document.getElementById('photoInput');

  dropzone.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('click', e => e.stopPropagation());
  photoInput.addEventListener('change', e => handleNewFiles([...e.target.files]));
  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    handleNewFiles([...e.dataTransfer.files]);
  });

  function handleNewFiles(files) {
    const MAX_PHOTOS = 40;
    files.forEach(file => {
      if (!file.type.startsWith('image/')) return;
      if (['image/heic','image/heif'].includes(file.type.toLowerCase()) || /\.heic$/i.test(file.name)) {
        CP.UI.toast(`"${file.name}" is in HEIC format (iPhone default). Go to Settings → Camera → Formats → Most Compatible to shoot in JPG, then re-upload.`, 'error');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        CP.UI.toast(`"${file.name}" is too large (${(file.size / 1048576).toFixed(1)} MB). Max 10 MB per photo.`, 'error');
        return;
      }
      if (pendingNewFiles.find(f => f.name === file.name && f.size === file.size)) return;
      const existingCount = document.querySelectorAll('#existingPhotosGrid .existing-photo-item').length;
      if (existingCount + pendingNewFiles.length >= MAX_PHOTOS) {
        CP.UI.toast(`Maximum ${MAX_PHOTOS} photos allowed per listing.`, 'error');
        return;
      }
      pendingNewFiles.push(file);
      const reader = new FileReader();
      reader.onload = (e) => addNewPhotoPreview(e.target.result, file);
      reader.readAsDataURL(file);
    });
    photoInput.value = '';
  }

  function addNewPhotoPreview(src, file) {
    const grid = document.getElementById('newPhotosGrid');
    const item = document.createElement('div');
    item.className = 'photo-preview-item';
    item.id        = `np-${file.name}-${file.size}`;
    item.innerHTML = `<img src="${src}" alt="Preview" loading="lazy"><button class="photo-remove-btn" title="Remove">✕</button>`;
    item.querySelector('.photo-remove-btn').addEventListener('click', () => {
      pendingNewFiles = pendingNewFiles.filter(f => !(f.name === file.name && f.size === file.size));
      item.remove();
    });
    grid.appendChild(item);
  }

  // ── Unsaved-changes guard ───────────────────────────────
  let _editDirty = false;
  document.getElementById('formCard').addEventListener('input',  () => { _editDirty = true; });
  document.getElementById('formCard').addEventListener('change', () => { _editDirty = true; });
  window.addEventListener('beforeunload', (e) => {
    if (_editDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ── Save listing ────────────────────────────────────────
  document.getElementById('saveBtn').addEventListener('click', saveListing);

  async function saveListing() {
    const btn = document.getElementById('saveBtn');
    const v   = id => document.getElementById(id)?.value?.trim();

    if (!v('title'))                          return CP.UI.toast('Please enter a listing title.', 'error');
    if (v('title').length > 120)              return CP.UI.toast('Title must be 120 characters or less.', 'error');
    if (!v('propertyType'))                   return CP.UI.toast('Please select a property type.', 'error');
    if (!v('address'))                        return CP.UI.toast('Please enter the property address.', 'error');
    if (!v('city'))                           return CP.UI.toast('Please enter the city.', 'error');
    if (!v('state'))                          return CP.UI.toast('Please select a state.', 'error');
    if (!v('zip'))                            return CP.UI.toast('Please enter the ZIP code.', 'error');
    if (!/^\d{5}(-\d{4})?$/.test(v('zip'))) return CP.UI.toast('Please enter a valid ZIP code (e.g. 90210).', 'error');
    if (!v('bedrooms'))                       return CP.UI.toast('Please select the number of bedrooms.', 'error');
    if (!v('bathrooms'))                      return CP.UI.toast('Please select the number of bathrooms.', 'error');
    if (!v('rent') || parseInt(v('rent')) < 1) return CP.UI.toast('Please enter a valid monthly rent.', 'error');
    if (parseInt(v('rent')) > 50000)          return CP.UI.toast('Monthly rent looks too high — please double-check.', 'error');
    const totalPhotos = currentPhotoUrls.length + pendingNewFiles.length;
    if (totalPhotos < 3)                      return CP.UI.toast('Please include at least 3 photos for a complete listing.', 'error');
    if (!v('description') || v('description').length < 50) return CP.UI.toast('Please write a description of at least 50 characters.', 'error');

    btn.disabled = true; btn.textContent = 'Saving…';

    // Geocode if address changed
    let lat = prop.lat || null;
    let lng = prop.lng || null;
    const addressChanged = v('address') !== prop.address || v('city') !== prop.city || v('zip') !== prop.zip;
    if (addressChanged || (!lat && !lng)) {
      try {
        const fullAddr = `${v('address')}, ${v('city')}, ${v('state')} ${v('zip')}`.trim();
        const _geoKey = (typeof CONFIG !== 'undefined' && CONFIG.GEOAPIFY_API_KEY) || '';
        if (_geoKey) {
          const geoRes = await fetch(
            `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(fullAddr)}&format=json&apiKey=${_geoKey}&filter=countrycode:us&limit=1`
          );
          const geoData = await geoRes.json();
          const hit = geoData?.results?.[0];
          if (hit) { lat = parseFloat(hit.lat); lng = parseFloat(hit.lon); }
        }
      } catch (e) { /* silent */ }
    }

    let finalPhotoUrls    = [...currentPhotoUrls];
    let finalPhotoFileIds = [...currentPhotoFileIds];

    if (pendingNewFiles.length) {
      if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
        CP.UI.toast('Photo uploads are not configured yet.', 'error');
        btn.disabled = false; btn.textContent = 'Save Changes';
        return;
      }
      btn.textContent = 'Verifying session…';
      const accessToken = await window.CP?.Auth?.getAccessToken?.();
      if (!accessToken) {
        CP.UI.toast('Session invalid — please log back in and try again.', 'error');
        btn.disabled = false; btn.textContent = 'Save Changes';
        setTimeout(() => { window.location.href = '/landlord/login.html'; }, 1500);
        return;
      }

      btn.textContent = 'Uploading photos…';
      const bar    = document.getElementById('uploadBar');
      const txt    = document.getElementById('uploadStatusText');
      const pctLbl = document.getElementById('uploadPct');
      document.getElementById('uploadProgress').style.display = '';

      try {
        let doneCount = 0;
        // Phase 3b: pass propertyId so the edge function inserts each
        // upload directly into the property_photos table. The Direction A
        // trigger then mirrors the change back into the legacy
        // photo_urls / photo_file_ids arrays for any reader still on the
        // old contract. We therefore stop writing the arrays from this
        // page (see the .update() below).
        const newResults = await uploadMultipleToImageKit(pendingNewFiles, {
          folder:      `/properties/${propertyId}`,
          propertyId,
          supabaseUrl: CONFIG.SUPABASE_URL,
          anonKey:     CONFIG.SUPABASE_ANON_KEY,
          userToken:   accessToken,
          onFileProgress:  (i, pct) => {
            if (pct === 100) doneCount++;
            txt.textContent = `Uploading photos… (${doneCount} of ${pendingNewFiles.length} done)`;
          },
          onTotalProgress: (overall) => {
            bar.style.width = overall + '%';
            pctLbl.textContent = overall + '%';
          },
        });

        const failed = newResults.filter(r => r?.error);
        for (const r of newResults) {
          if (r?.url) {
            finalPhotoUrls.push(r.url);
            finalPhotoFileIds.push(r.fileId ?? null);
          }
        }

        if (failed.length > 0 && finalPhotoUrls.length <= currentPhotoUrls.length) {
          const firstError = failed[0]?.error || 'Unknown error';
          const isSessionError  = /\b401\b|unauthorized|session expired|jwt/i.test(firstError);
          const isConfigError   = /not configured/i.test(firstError);
          const isImageKitError = /imagekit|502|credentials/i.test(firstError);
          let reason;
          if (isSessionError)       reason = 'Your session expired — please refresh the page, log back in, and try again.';
          else if (isConfigError)   reason = 'The photo upload service is not fully configured.';
          else if (isImageKitError) reason = 'Photo storage service error — please try again in a moment.';
          else                      reason = `Upload error: ${firstError}`;
          CP.UI.toast(`Photos could not be uploaded. ${reason}`, 'error');
          btn.disabled = false; btn.textContent = 'Save Changes';
          document.getElementById('uploadProgress').style.display = 'none';
          return;
        }

        if (failed.length > 0) {
          const names = failed.map(f => `"${f.fileName}"`).join(', ');
          CP.UI.toast(`${failed.length} photo(s) skipped: ${names}. You can retry after saving.`, 'info');
        }
      } catch (uploadErr) {
        CP.UI.toast('Photo upload failed: ' + uploadErr.message, 'error');
        btn.disabled = false; btn.textContent = 'Save Changes';
        document.getElementById('uploadProgress').style.display = 'none';
        return;
      }
      document.getElementById('uploadProgress').style.display = 'none';
    }

    const getChecked = name => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(c => c.value);

    if (finalPhotoUrls.length !== finalPhotoFileIds.length) {
      CP.UI.toast('Internal error: photo data is corrupted. Please refresh and try again.', 'error');
      console.error('INVARIANT VIOLATION: photo arrays out of sync', { finalPhotoUrls, finalPhotoFileIds });
      btn.disabled = false; btn.textContent = 'Save Changes';
      return;
    }

    // Phase 3b: photo_urls / photo_file_ids are now derived columns,
    // synced by the property_photos triggers from the new table. We
    // intentionally omit them from this UPDATE so that:
    //   • Newly uploaded photos (already inserted into property_photos
    //     by the imagekit-upload edge function) are not clobbered.
    //   • Removed photos (deleted via the imagekit-delete edge
    //     function, which calls delete_property_photo_by_file_id) are
    //     reflected by the Direction A trigger automatically.
    let updateQuery = supabase
      .from('properties')
      .update({
          title               : v('title'),
          property_type       : v('propertyType'),
          address             : v('address'),
          city                : v('city'),
          state               : v('state') || null,
          zip                 : v('zip') || null,
          lat, lng,
          bedrooms            : parseInt(v('bedrooms')),
          bathrooms           : parseFloat(v('bathrooms')),
          square_footage      : parseInt(v('sqft')) || null,
          monthly_rent        : parseInt(v('rent')),
          security_deposit    : parseInt(v('deposit')) || null,
          last_months_rent    : v('lastMonthRent') ? parseInt(v('lastMonthRent')) : null,
          admin_fee           : v('adminFee') ? parseInt(v('adminFee')) : null,
          move_in_special     : v('moveInSpecial') || null,
          available_date      : v('availDate') || null,
          application_fee     : parseInt(v('appFee')) || 0,
          status              : v('status'),
          pets_allowed        : document.querySelector('input[name="pets"]:checked')?.value === 'true',
          pet_types_allowed   : document.querySelector('input[name="pets"]:checked')?.value === 'true'
                                  ? [...document.querySelectorAll('#petTypesGroup input:checked')].map(c => c.value)
                                  : [],
          pet_weight_limit    : v('petWeightLimit') ? parseInt(v('petWeightLimit')) : null,
          pet_deposit         : v('petDeposit') ? parseInt(v('petDeposit')) : null,
          pet_details         : v('petDetails') || null,
          parking             : v('parking') || null,
          garage_spaces       : v('garageSpaces') ? parseInt(v('garageSpaces')) : null,
          parking_fee         : v('parkingFee') ? parseInt(v('parkingFee')) : null,
          ev_charging         : v('evCharging') || null,
          utilities_included  : getChecked('utilities'),
          amenities           : getChecked('amenities'),
          lease_terms         : getChecked('leaseTerms'),
          laundry_type        : v('laundryType') || null,
          heating_type        : v('heatingType') || null,
          cooling_type        : v('coolingType') || null,
          description         : v('description'),
          showing_instructions: v('showingInstructions') || null,
          minimum_income_multiplier: v('minIncome') ? parseFloat(v('minIncome')) : null,
          minimum_credit_score     : v('minCredit') ? parseInt(v('minCredit')) : null,
          // photo_urls / photo_file_ids intentionally omitted — see Phase 3b note above.
          updated_at          : new Date().toISOString()
      })
      .eq('id', propertyId);

    if (!_isAdmin && profile) updateQuery = updateQuery.eq('landlord_id', profile.id);
    const { error } = await updateQuery;

    if (error) {
      CP.UI.toast('Failed to save. Please try again.', 'error');
      btn.disabled = false; btn.textContent = 'Save Changes';
      return;
    }

    currentPhotoUrls    = finalPhotoUrls;
    currentPhotoFileIds = finalPhotoFileIds;
    originalPhotoFileIds = [...finalPhotoFileIds]; // keep in sync so re-saves don't re-fire CDN deletes
    pendingNewFiles     = [];
    document.getElementById('newPhotosGrid').innerHTML = '';
    renderExistingPhotos();

    _editDirty = false;
    CP.UI.toast('Listing updated successfully! <a href="/property.html?id=' + propertyId + '" target="_blank" style="color:inherit;text-decoration:underline">View listing →</a>', 'success');
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Save Changes'; }, 2500);

    // Fire CDN deletes for removed photos
    const removedFileIds = originalPhotoFileIds.filter(id => id && !finalPhotoFileIds.includes(id));
    if (removedFileIds.length) {
      const session = await CP.getSession().catch(() => null);
      const userToken = session?.access_token || CONFIG.SUPABASE_ANON_KEY;
      for (const fileId of removedFileIds) {
        deleteFromImageKit(fileId, {
          supabaseUrl: CONFIG.SUPABASE_URL,
          anonKey: CONFIG.SUPABASE_ANON_KEY,
          userToken,
        });
      }
    }
  }

  // ── Delete listing ──────────────────────────────────────
  const deleteModal      = document.getElementById('deleteModal');
  const openDeleteBtn    = document.getElementById('openDeleteBtn');
  const cancelDeleteBtn  = document.getElementById('cancelDeleteBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

  openDeleteBtn.addEventListener('click', async () => {
    const { count } = await supabase
      .from('applications')
      .select('app_id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
      .in('status', ['pending', 'under_review', 'approved', 'waitlisted']);

    const warningEl = document.getElementById('deleteWarning');
    if (count && count > 0) {
      warningEl.style.display = '';
      warningEl.innerHTML = `⚠️ This listing has <strong>${count} active application${count === 1 ? '' : 's'}</strong>. Deleting it will not automatically notify those applicants.`;
    } else {
      warningEl.style.display = 'none';
    }
    deleteModal.classList.add('is-open');
  });

  cancelDeleteBtn.addEventListener('click', () => deleteModal.classList.remove('is-open'));
  deleteModal.addEventListener('click', e => { if (e.target === deleteModal) deleteModal.classList.remove('is-open'); });

  confirmDeleteBtn.addEventListener('click', async () => {
    confirmDeleteBtn.disabled = true;
    confirmDeleteBtn.textContent = 'Deleting…';

    let deleteQuery = supabase.from('properties').delete().eq('id', propertyId);
    if (!_isAdmin && profile) deleteQuery = deleteQuery.eq('landlord_id', profile.id);
    const { error } = await deleteQuery;

    if (error) {
      CP.UI.toast('Failed to delete. Please try again.', 'error');
      confirmDeleteBtn.disabled = false;
      confirmDeleteBtn.textContent = 'Yes, delete';
      deleteModal.classList.remove('is-open');
      return;
    }

    const fileIdsToDelete = currentPhotoFileIds.filter(Boolean);
    if (fileIdsToDelete.length) {
      const session = await CP.getSession().catch(() => null);
      const userToken = session?.access_token || CONFIG.SUPABASE_ANON_KEY;
      for (const fileId of fileIdsToDelete) {
        deleteFromImageKit(fileId, {
          supabaseUrl: CONFIG.SUPABASE_URL,
          anonKey: CONFIG.SUPABASE_ANON_KEY,
          userToken,
        });
      }
    }

    _editDirty = false;
    CP.UI.toast('Listing deleted.', 'success');
    setTimeout(() => window.location.href = backURL, 1500);
  });


