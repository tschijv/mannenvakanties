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

/* ---- In-place bijschriften: opslaan zonder herladen ---- */
document.querySelectorAll('.cap-form').forEach(function (form) {
  var input = form.querySelector('input[name=caption]');
  var tokenEl = form.querySelector('input[name=_csrf]');
  if (!input || !tokenEl) return;
  var btn = form.querySelector('button');
  if (btn) btn.style.display = 'none';
  var status = document.createElement('span');
  status.className = 'cap-status';
  form.appendChild(status);
  var last = input.value;
  function save() {
    if (input.value === last) return;
    last = input.value;
    status.textContent = 'Opslaan…';
    fetch(form.getAttribute('action'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', 'X-CSRF-Token': tokenEl.value },
      body: 'caption=' + encodeURIComponent(input.value)
    }).then(function (r) { if (!r.ok) throw new Error(); return r.json().catch(function () { return {}; }); })
      .then(function () { status.textContent = '✓ opgeslagen'; setTimeout(function () { status.textContent = ''; }, 1500); })
      .catch(function () { status.textContent = 'opslaan mislukt'; });
  }
  input.addEventListener('blur', save);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  form.addEventListener('submit', function (e) { e.preventDefault(); save(); });
});

/* ---- Slepen om de volgorde te wijzigen (desktop) ---- */
(function () {
  var thumbs = document.querySelector('.thumbs');
  if (!thumbs || !thumbs.dataset.orderUrl) return;
  var dragEl = null;
  function cards() { return [].slice.call(thumbs.querySelectorAll('.thumb')); }
  cards().forEach(function (card) {
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', function (e) {
      if (e.target.closest('input, textarea, button, a, label')) { e.preventDefault(); return; }
      dragEl = card; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', card.id); } catch (x) {}
    });
    card.addEventListener('dragend', function () { card.classList.remove('dragging'); dragEl = null; persist(); });
    card.addEventListener('dragover', function (e) {
      if (!dragEl || dragEl === card) return;
      e.preventDefault();
      var rect = card.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) thumbs.insertBefore(dragEl, card);
      else thumbs.insertBefore(dragEl, card.nextSibling);
    });
  });
  var saving = false, lastOrder = '';
  function persist() {
    var ids = cards().map(function (c) { return c.id.replace('foto-', ''); });
    var order = ids.join(',');
    if (order === lastOrder || saving) return;
    lastOrder = order; saving = true;
    fetch(thumbs.dataset.orderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', 'X-CSRF-Token': thumbs.dataset.csrf },
      body: 'order=' + encodeURIComponent(order)
    }).finally(function () { saving = false; });
  }
})();

/* ---- Bulkselectie ---- */
(function () {
  var boxes = [].slice.call(document.querySelectorAll('.selbox'));
  var bar = document.getElementById('bulkbar');
  if (!boxes.length || !bar) return;
  var nEl = document.getElementById('bulkN');
  function selected() { return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; }); }
  function update() { var s = selected(); nEl.textContent = s.length; bar.hidden = s.length === 0; }
  boxes.forEach(function (b) { b.addEventListener('change', update); });
  var clear = document.getElementById('bulkClear');
  if (clear) clear.addEventListener('click', function () { boxes.forEach(function (b) { b.checked = false; }); update(); });
  bar.querySelectorAll('[data-bulk]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var s = selected(); if (!s.length) return;
      var conf = btn.getAttribute('data-confirm');
      if (conf && !confirm(conf.replace('%n', s.length))) return;
      document.getElementById('bulkIds').value = s.join(',');
      document.getElementById('bulkAction').value = btn.getAttribute('data-bulk');
      bar.submit();
    });
  });
})();
