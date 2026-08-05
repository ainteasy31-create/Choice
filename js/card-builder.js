// ============================================================
// Choice Properties — Unified Property Card Builder
// Provides: window.buildPropertyCard(p, opts)
//           window.initCardCarousel(card)
//
// Used by both index.html (featured section) and listings.html.
// Ensures pixel-perfect consistency between every card across
// the entire site. Always edit this file — never the per-page
// duplicates that this module replaced.
// ============================================================

(function () {
  'use strict';

  // ── HTML escape helper ──────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    return esc(s).replace(/'/g, '&#39;');
  }

  // ── Slug helpers for city-page links ────────────────────────
  function toSlug(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  var _STATE_SLUG = {
    AL:'alabama',AK:'alaska',AZ:'arizona',AR:'arkansas',CA:'california',
    CO:'colorado',CT:'connecticut',DE:'delaware',FL:'florida',GA:'georgia',
    HI:'hawaii',ID:'idaho',IL:'illinois',IN:'indiana',IA:'iowa',
    KS:'kansas',KY:'kentucky',LA:'louisiana',ME:'maine',MD:'maryland',
    MA:'massachusetts',MI:'michigan',MN:'minnesota',MS:'mississippi',MO:'missouri',
    MT:'montana',NE:'nebraska',NV:'nevada',NH:'new-hampshire',NJ:'new-jersey',
    NM:'new-mexico',NY:'new-york',NC:'north-carolina',ND:'north-dakota',OH:'ohio',
    OK:'oklahoma',OR:'oregon',PA:'pennsylvania',RI:'rhode-island',SC:'south-carolina',
    SD:'south-dakota',TN:'tennessee',TX:'texas',UT:'utah',VT:'vermont',
    VA:'virginia',WA:'washington',WV:'west-virginia',WI:'wisconsin',WY:'wyoming',
    DC:'district-of-columbia'
  };

  function cityPageUrl(city, state) {
    if (!city || !state) return null;
    var stateSlug = _STATE_SLUG[String(state).toUpperCase()] || toSlug(state);
    var citySlug  = toSlug(city);
    if (!stateSlug || !citySlug) return null;
    return '/listings/' + stateSlug + '/' + citySlug;
  }

  // ── Rent formatter ──────────────────────────────────────────
  // P2-D: Wrap $ in branded span so it renders in brand blue.
  function fmtRent(v) {
    const n = Number(v);
    if (!n || n <= 0) return 'Contact';
    return '<span class="property-card-price-dollar">$</span>' + n.toLocaleString();
  }

  // ── Freshness chip (Phase 9.2) ──────────────────────────────
  // Uses listed_at (original source listing date) — NOT created_at (scrape date).
  // Shows "Just listed" chip on the photo ONLY for properties under 30 hours old.
  // All other properties show the exact date via listedDateLabel() instead.
  function freshnessLabel(listedAt) {
    if (!listedAt) return null;
    var raw = String(listedAt);
    var t = raw.length === 10
      ? new Date(raw + 'T12:00:00').getTime()
      : new Date(raw).getTime();
    if (isNaN(t)) return null;
    var hours = (Date.now() - t) / 36e5;
    if (hours >= 0 && hours < 30) return 'Just listed';
    return null;
  }

  // ── Listed date label ────────────────────────────────────────
  // Shows the exact original listing date on every card — "Listed Jun 22".
  // Matches the date format used on Zillow / Realtor.com.
  // Shown for ALL properties so renters always see when it first hit the market.
  function listedDateLabel(listedAt) {
    if (!listedAt) return null;
    var raw = String(listedAt);
    var t = raw.length === 10
      ? new Date(raw + 'T12:00:00').getTime()
      : new Date(raw).getTime();
    if (isNaN(t)) return null;
    var d = new Date(t);
    return 'Listed ' + d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  }

  // ── Availability chip ───────────────────────────────────────
  // Only shown when the available date is in the future — "Avail. Sep 1".
  // "Available Now" is implied for any listed property and is omitted.
  function availChipHtml(p) {
    if (p.available_date) {
      var avail = new Date(p.available_date + 'T00:00:00');
      var diffDays = Math.ceil((avail - Date.now()) / 864e5);
      if (diffDays > 0) {
        var label = avail.toLocaleString('en-US', { month: 'short', day: 'numeric' });
        return '<span class="property-card-avail">Avail. ' + label + '</span>';
      }
    }
    return '';
  }

  // ── Unified card builder ────────────────────────────────────
  /**
   * Build a property card HTML string.
   *
   * @param {Object} p     - property row from Supabase (with landlords join)
   * @param {Object} opts
   *   opts.imgSizes  {string}  - responsive sizes attr (default covers up to 4-col grid)
   */
  function buildPropertyCard(p, opts) {
    opts = opts || {};
    const imgSizes = opts.imgSizes ||
      '(max-width: 399px) calc(100vw - 32px), (max-width: 899px) calc(50vw - 28px), (max-width: 1319px) calc(33vw - 32px), calc(25vw - 32px)';

    const photos = (p.photo_urls && p.photo_urls.length) ? p.photo_urls : ['/assets/placeholder-property.jpg'];
    const title  = esc(p.title || 'Rental property');
    const id     = esc(p.id);
    const propUrl = (window.CP && window.CP.UI && window.CP.UI.propertyUrl)
      ? window.CP.UI.propertyUrl(p)
      : '/property.html?id=' + id;

    // ── Image slides ──────────────────────────────────────────
    const slidesHtml = photos.map(function (url, i) {
      const imgSrc    = (window.CONFIG && CONFIG.img)    ? CONFIG.img(url, 'card')               : url;
      const imgSrcset = (window.CONFIG && CONFIG.srcset) ? CONFIG.srcset(url, 'card', 'card_2x') : '';
      const lqip      = (window.CP && CP.UI && CP.UI.lqipUrl) ? CP.UI.lqipUrl(url) : '';
      const lqipStyle = lqip ? ' style="background-image:url(\'' + escAttr(lqip) + '\');background-size:cover;background-position:center"' : '';
      return (
        '<div class="property-card-slide"' + lqipStyle + '>' +
          '<img src="' + escAttr(imgSrc) + '"' +
          (imgSrcset ? ' srcset="' + escAttr(imgSrcset) + '"' : '') +
          ' alt="' + title + ' photo ' + (i + 1) + '"' +
          ' sizes="' + imgSizes + '"' +
          ' loading="' + (i === 0 ? 'eager' : 'lazy') + '"' +
          (i === 0 ? ' fetchpriority="high"' : '') +
          ' decoding="async">' +
        '</div>'
      );
    }).join('');

    // ── Specs row — beds + baths + sqft (sqft is a key decision factor) ─
    var specParts = [];
    if (p.bedrooms != null) specParts.push('<span class="property-card-spec-item"><i class="fas fa-bed"></i>' + (p.bedrooms === 0 ? 'Studio' : p.bedrooms + ' Bed') + '</span>');
    if (p.bathrooms)        specParts.push('<span class="property-card-spec-item"><i class="fas fa-bath"></i>' + p.bathrooms + ' Bath</span>');
    if (p.square_footage)   specParts.push('<span class="property-card-spec-item"><i class="fas fa-ruler-combined"></i>' + Number(p.square_footage).toLocaleString() + ' sqft</span>');
    var specsHtml = specParts.map(function (s, i) {
      return i === 0 ? s : '<span class="property-card-spec-sep">·</span>' + s;
    }).join('');

    // ── Badge — priority: featured > verified ─────────────────
    var badge = '';
    if (p.featured) {
      badge = '<div class="property-card-badge badge-featured"><i class="fas fa-star"></i> Featured</div>';
    } else if (p.landlords && p.landlords.verified) {
      badge = '<div class="property-card-badge badge-verified"><i class="fas fa-shield-halved"></i> Verified</div>';
    }

    var freshLabel = freshnessLabel(p.listed_at);
    var freshChipHtml = freshLabel
      ? '<div class="property-card-fresh-chip"><span class="property-card-fresh-dot"></span>' + freshLabel + '</div>'
      : '';

    var listedLabel = listedDateLabel(p.listed_at);

    // Type chip removed from card — type is in the title and the filter bar.

    // ── P2-B: Dots (≤6 photos) OR count pill (>6 photos) — never both ──
    var dotsHtml = '';
    var photoCountHtml = '';
    if (photos.length > 1) {
      if (photos.length <= 6) {
        var dotItems = photos.map(function(_, i) {
          return '<button class="property-card-dot' + (i === 0 ? ' active' : '') + '" type="button" data-idx="' + i + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '" aria-label="View photo ' + (i + 1) + '"></button>';
        }).join('');
        dotsHtml = '<div class="property-card-dots" role="tablist">' + dotItems + '</div>';
      } else {
        photoCountHtml = '<div class="property-card-photo-count"><i class="fas fa-camera"></i> ' + photos.length + '</div>';
      }
    }

    // ── Address ───────────────────────────────────────────────
    var addrLine = esc([p.address, p.city, p.state].filter(Boolean).join(', '));

    // ── Availability chip ─────────────────────────────────────
    var avail = availChipHtml(p);

    // ── Pet policy chip — shown when pets are allowed ─────────
    var petChip = '';
    if (p.pets_allowed === true) {
      petChip = '<span class="property-card-pet-chip"><i class="fas fa-paw"></i> Pets OK</span>';
    } else if (p.pets_allowed === false) {
      petChip = '<span class="property-card-pet-chip property-card-pet-chip--no"><i class="fas fa-ban"></i> No Pets</span>';
    }

    // ── Price ─────────────────────────────────────────────────
    var rentHtml = fmtRent(p.monthly_rent);
    var rentUnit = Number(p.monthly_rent) > 0 ? '<span class="property-card-price-unit">/mo</span>' : '';

    return (
      '<article class="property-card" data-id="' + id + '"' + (p.featured ? ' data-featured="1"' : '') + '>' +

        // ── Image block ────────────────────────────────────────
        '<div class="property-card-img">' +
          '<div class="property-card-slides">' + slidesHtml + '</div>' +
          // Featured / verified badge — top-left (self-positioned via .property-card-badge)
          badge +
          // Freshness chip — stacks under badge (Phase 9.2)
          freshChipHtml +
          // Carousel position indicators — bottom-center
          dotsHtml +
          // Photo count — bottom-right (only when >6 photos)
          photoCountHtml +
          // Save heart — top-right, sole action on the photo
          '<div class="property-card-actions">' +
            '<button class="property-card-save" type="button" data-id="' + id + '" aria-label="Save property">' +
              '<i class="far fa-heart"></i>' +
            '</button>' +
          '</div>' +
          // Carousel arrows — desktop only (hidden on touch via CSS)
          (photos.length > 1
            ? '<button class="property-card-arrow property-card-arrow--prev" type="button" aria-label="Previous photo"><i class="fas fa-chevron-left"></i></button>' +
              '<button class="property-card-arrow property-card-arrow--next" type="button" aria-label="Next photo"><i class="fas fa-chevron-right"></i></button>'
            : '') +
        '</div>' +

        // ── Body — full-width link for click-through ───────────
        '<a href="' + escAttr(propUrl) + '" class="property-card-body" aria-label="' + title + '">' +
          // 1. Title (2-line clamp — most prominent element)
          '<div class="property-card-title">' + title + '</div>' +
          // 2. Address + availability chip inline
          '<div class="property-card-addr">' +
            '<i class="fas fa-location-dot"></i>' + addrLine +
            (avail ? '<span class="property-card-addr-sep">·</span>' + avail : '') +
            (listedLabel ? '<span class="property-card-addr-sep">·</span><span class="property-card-listed-date">' + listedLabel + '</span>' : '') +
          '</div>' +
          // 3. Specs — beds + baths + sqft
          (specsHtml ? '<div class="property-card-specs">' + specsHtml + '</div>' : '') +
          // 3b. Pet policy chip
          (petChip ? '<div class="property-card-pet-row">' + petChip + '</div>' : '') +
          // 4. Footer — price pinned to bottom (no divider)
          '<div class="property-card-footer">' +
            '<div class="property-card-price">' + rentHtml + rentUnit + '</div>' +
            (cityPageUrl(p.city, p.state)
              ? '<button class="prop-city-badge" type="button" data-city-url="' + escAttr(cityPageUrl(p.city, p.state)) + '" title="Browse all ' + esc(p.city) + ' listings" aria-label="View all listings in ' + esc(p.city) + ', ' + esc(p.state) + '">' +
                  '<i class="fas fa-location-dot"></i> ' + esc(p.city) + ', ' + esc(p.state) +
                '</button>'
              : '') +
          '</div>' +
        '</a>' +

      '</article>'
    );
  }

  // ── Carousel initialiser ────────────────────────────────────
  /**
   * Attach carousel touch-swipe and keyboard behaviour to a card element.
   * Nav arrows removed — navigation via swipe (touch) and arrow keys (keyboard).
   */
  function initCardCarousel(card) {
    var slides = card.querySelector('.property-card-slides');
    if (!slides) return;

    var total = card.querySelectorAll('.property-card-slide').length;
    if (total < 2) return;

    var idx  = 0;
    var dots = Array.prototype.slice.call(card.querySelectorAll('.property-card-dot'));

    function goTo(n) {
      idx = (n + total) % total;
      slides.style.transform = 'translateX(-' + (idx * 100) + '%)';
      // P2-B: Update active dot (buttons are focusable + clickable)
      dots.forEach(function(dot, i) {
        var active = i === idx;
        dot.classList.toggle('active', active);
        dot.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    // Click handlers for dots
    dots.forEach(function(dot) {
      dot.addEventListener('click', function (e) { e.stopPropagation(); goTo(parseInt(this.dataset.idx, 10)); });
    });

    // Touch swipe
    var touchX = 0;
    slides.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    slides.addEventListener('touchend', function (e) {
      var diff = touchX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 40) goTo(idx + (diff > 0 ? 1 : -1));
    }, { passive: true });

    // Desktop arrow buttons
    var prevBtn = card.querySelector('.property-card-arrow--prev');
    var nextBtn = card.querySelector('.property-card-arrow--next');
    if (prevBtn) prevBtn.addEventListener('click', function (e) { e.stopPropagation(); goTo(idx - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function (e) { e.stopPropagation(); goTo(idx + 1); });

    // P3-B: Keyboard navigation — ArrowLeft/ArrowRight when card has focus
    function onKeyDown(e) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); goTo(idx - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goTo(idx + 1); }
    }
    card.setAttribute('tabindex', card.getAttribute('tabindex') || '0');
    card.addEventListener('focus',  function () { document.addEventListener('keydown', onKeyDown); });
    card.addEventListener('blur',   function (e) {
      if (!card.contains(e.relatedTarget)) { document.removeEventListener('keydown', onKeyDown); }
    });
  }

  // ── Expose globally ─────────────────────────────────────────
  window.buildPropertyCard = buildPropertyCard;
  window.initCardCarousel  = initCardCarousel;

})();
