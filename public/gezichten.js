'use strict';
/* Gezichten taggen: teken een vak op de foto, koppel het daarna aan een persoon. */
(function () {
  var stage = document.getElementById('tagStage');
  var img = document.getElementById('tagImg');
  var draft = document.getElementById('tagDraft');
  var form = document.getElementById('tagAddForm');
  if (!stage || !img || !draft || !form) return;

  var fx = document.getElementById('fx'), fy = document.getElementById('fy');
  var fw = document.getElementById('fw'), fh = document.getElementById('fh');
  var cancel = document.getElementById('addCancel');

  var drawing = false, x0 = 0, y0 = 0;
  var MIN = 0.03; // kleinste zinvolle vak (3% van de foto)

  function frac(ev) {
    var r = img.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))
    };
  }

  function place(x, y, w, h) {
    draft.style.left = (x * 100).toFixed(2) + '%';
    draft.style.top = (y * 100).toFixed(2) + '%';
    draft.style.width = (w * 100).toFixed(2) + '%';
    draft.style.height = (h * 100).toFixed(2) + '%';
  }

  stage.addEventListener('pointerdown', function (ev) {
    // niet starten vanaf de bestaande boxen of bedieningselementen
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    var p = frac(ev);
    drawing = true; x0 = p.x; y0 = p.y;
    form.hidden = true;
    draft.hidden = false;
    place(x0, y0, 0, 0);
    try { stage.setPointerCapture(ev.pointerId); } catch (e) {}
  });

  stage.addEventListener('pointermove', function (ev) {
    if (!drawing) return;
    var p = frac(ev);
    place(Math.min(x0, p.x), Math.min(y0, p.y), Math.abs(p.x - x0), Math.abs(p.y - y0));
  });

  function finish(ev) {
    if (!drawing) return;
    drawing = false;
    var p = frac(ev);
    var x = Math.min(x0, p.x), y = Math.min(y0, p.y);
    var w = Math.abs(p.x - x0), h = Math.abs(p.y - y0);
    if (w < MIN || h < MIN) { draft.hidden = true; return; }
    fx.value = x.toFixed(4); fy.value = y.toFixed(4);
    fw.value = w.toFixed(4); fh.value = h.toFixed(4);
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    var sel = document.getElementById('addPerson');
    if (sel) sel.focus();
  }

  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', function () { drawing = false; draft.hidden = true; });

  if (cancel) cancel.addEventListener('click', function () {
    form.hidden = true; draft.hidden = true;
  });
})();
