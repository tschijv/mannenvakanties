'use strict';

document.querySelectorAll('[data-geocode]').forEach(function (btn) {
  var form = btn.closest('form');
  if (!form) return;
  var status = form.querySelector('[data-geocode-status]');
  function setStatus(msg) { if (status) status.textContent = msg; }

  btn.addEventListener('click', function () {
    var placeEl = form.querySelector('[name=place]');
    var latEl = form.querySelector('[name=lat]');
    var lngEl = form.querySelector('[name=lng]');
    var place = (placeEl ? placeEl.value : '').trim();
    if (!place) { setStatus('Vul eerst een plaats in.'); return; }

    setStatus('Coördinaten opzoeken…');
    btn.disabled = true;
    fetch('/beheer/geocode?q=' + encodeURIComponent(place))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { setStatus(d.error); return; }
        if (latEl) latEl.value = Number(d.lat).toFixed(6);
        if (lngEl) lngEl.value = Number(d.lng).toFixed(6);
        setStatus('Gevonden: ' + d.name + '. Klik op Opslaan om te bewaren.');
      })
      .catch(function () { setStatus('Kon de zoekdienst niet bereiken.'); })
      .finally(function () { btn.disabled = false; });
  });
});
