'use strict';

(function () {
  var dataEl = document.getElementById('map-data');
  if (!dataEl || typeof L === 'undefined') return;

  var years = [];
  try { years = JSON.parse(dataEl.textContent); } catch (e) { years = []; }
  if (!years.length) return;

  var map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  var bounds = [];
  years.forEach(function (y) {
    if (y.lat == null || y.lng == null) return;
    bounds.push([y.lat, y.lng]);

    var safePlace = (y.place || '').replace(/[<>&]/g, '');
    var cover = y.cover_id
      ? '<span class="pop-cover"><img src="/thumb/' + y.cover_id + '" alt=""></span>'
      : '';
    var html =
      '<a class="pop" href="/jaar/' + y.id + '">' +
      cover +
      '<span class="pop-body">' +
      '<b class="pop-year">' + y.year + '</b>' +
      (safePlace ? '<span class="pop-place">' + safePlace + '</span>' : '') +
      '<span class="pop-count">' + y.count + ' foto' + (y.count === 1 ? '' : "'s") + ' &rarr;</span>' +
      '</span></a>';

    L.marker([y.lat, y.lng]).addTo(map).bindPopup(html, { className: 'mv-popup' });
  });

  if (bounds.length === 1) {
    map.setView(bounds[0], 9);
  } else if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }

  // klik op de kaart geeft de scroll terug; dubbelklik niet nodig
  map.on('focus', function () { map.scrollWheelZoom.enable(); });
  map.on('blur', function () { map.scrollWheelZoom.disable(); });
})();
