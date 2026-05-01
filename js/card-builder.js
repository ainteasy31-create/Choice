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

  // ── Rent formatter ──────────────────────────────────────────
  // P2-D: Wrap $ in branded span so it renders in brand blue.
  function fmtRent(v) {
    const n = Number(v);
    if (!n || n <= 0) return 'Contact';
    return '<span class="property-card-price-dollar">$</span>' + n.toLocaleString();
  }

  // ── Freshness label (Phase 9.2) ─────────────────────────────
  // Returns a small chip text for cards listed within the last 7 days.
  // Returns null otherwise (chip omitted entirely from the card markup).
  //   < 30h    → "Just listed"
  //   30h–168h → "N days ago" (rounded to whole days)
  //   > 7 days → null (no chip)
  function freshnessLabel(createdAt) {
    if (!createdAt) return null;
    var t = new Date(createdAt).getTime();
    if (isNaN(t)) return null;
    var hours = (Date.now() - t) / 36e5;
    if (hours < 0) return null;
    if (hours < 30) return 'Just listed';
    if (hours < 168) {
      var days = Math.max(1, Math.round(hours / 24));
      return days + (days === 1 ? ' day ago' : ' days ago');
    }
    return null;
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
      '(max-width: 539px) calc(100vw - 32px), (max-width: 899px) calc(50vw - 28px), (max-width: 1319px) calc(33vw - 32px), calc(25vw - 32px)';

    const photos = (p.photo_urls && p.photo_urls.length) ? p.photo_urls : ['/assets/placeholder-property.jpg'];
    const title  = esc(p.title || 'Rental property');
    const id     = esc(p.id);

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

    // ── Amenity tags ──────────────────────────────────────────
    var tags = [];
    if (p.pets_allowed) tags.push('<span class="property-card-tag tag-pet"><i class="fas fa-paw"></i> Pets OK</span>');
    if (p.parking)      tags.push('<span class="property-card-tag tag-parking"><i class="fas fa-car"></i> Parking</span>');
    if (Array.isArray(p.utilities_included) ? p.utilities_included.length > 0 : !!p.utilities_included) {
      tags.push('<span class="property-card-tag tag-utilities"><i class="fas fa-bolt"></i> Utilities</span>');
    }

    // ── Specs row ─────────────────────────────────────────────
    var specParts = [];
    if (p.bedrooms != null) specParts.push('<span class="property-card-spec-item"><i class="fas fa-bed"></i>' + (p.bedrooms === 0 ? 'Studio' : p.bedrooms + ' Bed') + '</span>');
    if (p.bathrooms)        specParts.push('<span class="property-card-spec-item"><i class="fas fa-bath"></i>' + p.bathrooms + ' Bath</span>');
    if (p.square_footage)   specParts.push('<span class="property-card-spec-item">' + Number(p.square_footage).toLocaleString() + ' sqft</span>');
    var specsHtml = specParts.map(function (s, i) {
      return i === 0 ? s : '<span class="property-card-spec-sep">·</span>' + s;
    }).join('');

    // ── Badge — priority: featured > verified ────
      // Availability badges ("Available Now" / "Avail. <date>") are intentionally
      // not rendered on public cards per request — only marketing-relevant labels remain.
      var badge = '';
      if (p.featured) {
        badge = '<div class="property-card-badge badge-featured"><i class="fas fa-star"></i> Featured</div>';
      } else if (p.landlords && p.landlords.verified) {
        badge = '<div class="property-card-badge badge-verified"><i class="fas fa-shield-halved"></i> Verified</div>';
      }

    var freshChipHtml = '';


    // P2-C: Property type label — defined here so typeChipHtml below can use it ──────
    var typeMap = { apartment: 'Apartment', house: 'House', condo: 'Condo', townhouse: 'Townhouse',
                    townhome: 'Townhome', studio: 'Studio', loft: 'Loft', room: 'Room', duplex: 'Duplex' };
    var typeLabel = p.property_type ? (typeMap[String(p.property_type).toLowerCase()] || esc(p.property_type)) : '';
    var typeHtml  = typeLabel ? '<div class="property-card-type">' + typeLabel + '</div>' : '';

    // ── Property type chip (bottom-left of image) ─────────────
    var typeChipHtml = typeLabel
      ? '<div class="property-card-type-chip">' + typeLabel + '</div>'
      : '';

    // P2-B: Dots (≤6 photos) OR count pill (>6 photos) — never both
    var dotsHtml = '';
    var photoCountHtml = '';
    if (photos.length > 1) {
      if (photos.length <= 6) {
        var dotItems = photos.map(function(_, i) {
          return '<span class="property-card-dot' + (i === 0 ? ' active' : '') + '"></span>';
        }).join('');
        dotsHtml = '<div class="property-card-dots">' + dotItems + '</div>';
      } else {
        photoCountHtml = '<div class="property-card-photo-count"><i class="fas fa-camera"></i> ' + photos.length + '</div>';
      }
    }

    // ── Address ───────────────────────────────────────────────
    var addrLine = esc([p.address, p.city, p.state].filter(Boolean).join(', '));

    // ── Price ─────────────────────────────────────────────────
    var rentHtml = fmtRent(p.monthly_rent);
    var rentUnit = Number(p.monthly_rent) > 0 ? '<span class="property-card-price-unit">/mo</span>' : '';

    return (
      '<article class="property-card" data-id="' + id + '">' +

        // Image block — contains all overlaid buttons (save, share, badge, dots)
        // Not wrapped in <a>; card click-through is handled by event delegation.
        '<div class="property-card-img">' +
          '<div class="property-card-slides">' + slidesHtml + '</div>' +
          // Featured / verified badge — top-left
          badge +
          // Freshness chip — top-left, stacks under badge (Phase 9.2)
          freshChipHtml +
          // Carousel position indicators — bottom-center
          dotsHtml +
          photoCountHtml +
          // Property type chip — bottom-left
          typeChipHtml +
          // Share icon — bottom-right, always visible
          // URL: canonical slug URL (Phase C SEO). Falls back to /property.html?id= when fields missing.
          '<button class="property-card-share" data-id="' + id + '" data-title="' + title + '" data-url="' + (window.CP && window.CP.UI && window.CP.UI.propertyUrl ? window.CP.UI.propertyUrl(p) : '/property.html?id=' + id) + '" aria-label="Share property"><i class="fas fa-share-nodes"></i></button>' +
        '</div>' +

        // Body — full-width link for clean click-through (canonical slug URL — Phase C)
        '<a href="' + (window.CP && window.CP.UI && window.CP.UI.propertyUrl ? window.CP.UI.propertyUrl(p) : '/property.html?id=' + id) + '" class="property-card-body" aria-label="' + title + '">' +
          typeHtml +
          '<div class="property-card-price">' + rentHtml + rentUnit + '</div>' +
          (specsHtml ? '<div class="property-card-specs">' + specsHtml + '</div>' : '') +
          '<div class="property-card-title">' + title + '</div>' +
          '<div class="property-card-addr"><i class="fas fa-location-dot"></i>' + addrLine + '</div>' +
          (tags.length ? '<div class="property-card-tags">' + tags.join('') + '</div>' : '') +
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
    var dots = card.querySelectorAll('.property-card-dot');

    function goTo(n) {
      idx = (n + total) % total;
      slides.style.transform = 'translateX(-' + (idx * 100) + '%)';
      // P2-B: Update active dot
      dots.forEach(function(dot, i) { dot.classList.toggle('active', i === idx); });
    }

    // Touch swipe
    var touchX = 0;
    slides.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    slides.addEventListener('touchend', function (e) {
      var diff = touchX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 40) goTo(idx + (diff > 0 ? 1 : -1));
    }, { passive: true });

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
