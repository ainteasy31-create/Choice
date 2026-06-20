// listings.js — redirected to the unified Property Manager (properties.js)
// This file is kept as a no-op for any lingering <script> references.
// The redirect is handled in listings.html.
(function () {
  'use strict';
  // If somehow this file still loads on a non-redirect page, send the user to properties.
  if (document.title && document.title.toLowerCase().includes('listing')) {
    var p = new URLSearchParams(location.search);
    location.replace('/listings.html' + (p.toString() ? '?' + p.toString() : ''));
  }
})();
