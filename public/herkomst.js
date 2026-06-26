'use strict';

// Kaart met de herkomst van bezoekers: een cirkel per plek, grootte ~ aantal weergaves.
(function () {
  var dataEl = document.getElementById('map-data');
  if (!dataEl || typeof L === 'undefined') return;

  var places = [];
  try { places = JSON.parse(dataEl.textContent); } catch (e) { places = []; }
  if (!places.length) return;

  var map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  var maxViews = places.reduce(function (m, p) { return Math.max(m, p.views || 0); }, 1);
  var bounds = [];

  places.forEach(function (p) {
    if (p.lat == null || p.lng == null) return;
    bounds.push([p.lat, p.lng]);
    var radius = 6 + 22 * Math.sqrt((p.views || 1) / maxViews); // 6–28 px
    var where = [p.city, p.country_name || p.country].filter(Boolean).join(', ') || 'Onbekend';
    var safe = where.replace(/[<>&]/g, '');
    var html = '<b>' + safe + '</b><br>' + p.views + ' weergave' + (p.views === 1 ? '' : 's') +
      ' · ' + p.visitors + ' bezoeker' + (p.visitors === 1 ? '' : 's');
    L.circleMarker([p.lat, p.lng], {
      radius: radius, color: '#9c3b2e', weight: 1.5, fillColor: '#b48a4b', fillOpacity: 0.55
    }).addTo(map).bindPopup(html, { className: 'mv-popup' });
  });

  if (bounds.length === 1) map.setView(bounds[0], 6);
  else if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40] });

  map.on('focus', function () { map.scrollWheelZoom.enable(); });
  map.on('blur', function () { map.scrollWheelZoom.disable(); });
})();
