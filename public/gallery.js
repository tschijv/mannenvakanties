'use strict';

/* Lightbox met bladeren + zoomen */
const lb = document.getElementById('lightbox');
const lbImg = document.getElementById('lbImg');
const lbCap = document.getElementById('lbCap');
const lbClose = document.getElementById('lbClose');
const lbPrev = document.getElementById('lbPrev');
const lbNext = document.getElementById('lbNext');
const lbDownload = document.getElementById('lbDownload');
const lbZoomIn = document.getElementById('lbZoomIn');
const lbZoomOut = document.getElementById('lbZoomOut');

let items = [];
let idx = -1;
let scale = 1, tx = 0, ty = 0, curRot = 0, baseFit = 1;
const MINS = 1, MAXS = 6;

function computeFit() {
  baseFit = 1;
  if (!curRot || curRot % 360 === 0) return;
  const availW = Math.min(1000, window.innerWidth * 0.92), availH = window.innerHeight * 0.78;
  const nw = lbImg.naturalWidth || 1, nh = lbImg.naturalHeight || 1;
  const s0 = Math.min(availW / nw, availH / nh, 1);
  const dw = nw * s0, dh = nh * s0;
  const rad = curRot * Math.PI / 180;
  const bw = Math.abs(dw * Math.cos(rad)) + Math.abs(dh * Math.sin(rad));
  const bh = Math.abs(dw * Math.sin(rad)) + Math.abs(dh * Math.cos(rad));
  baseFit = Math.min(availW / bw, availH / bh, 1);
}

function applyTransform() {
  if (scale <= 1) { scale = 1; tx = 0; ty = 0; }
  else {
    const maxX = Math.max(0, (lbImg.offsetWidth * scale * baseFit - window.innerWidth) / 2 + 40);
    const maxY = Math.max(0, (lbImg.offsetHeight * scale * baseFit - window.innerHeight) / 2 + 40);
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  }
  lbImg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + (scale * baseFit) + ') rotate(' + curRot + 'deg)';
  lbImg.classList.toggle('zoomed', scale > 1);
  if (lbZoomOut) lbZoomOut.disabled = scale <= MINS;
  if (lbZoomIn) lbZoomIn.disabled = scale >= MAXS;
}
function resetZoom() { scale = 1; tx = 0; ty = 0; if (lbImg) applyTransform(); }

function zoomAt(cx, cy, newScale) {
  newScale = Math.max(MINS, Math.min(MAXS, newScale));
  const rect = lbImg.getBoundingClientRect();
  const Cx = rect.left + rect.width / 2 - tx;
  const Cy = rect.top + rect.height / 2 - ty;
  const dx = cx - Cx, dy = cy - Cy;
  const k = newScale / scale;
  tx = dx - k * (dx - tx);
  ty = dy - k * (dy - ty);
  scale = newScale;
  applyTransform();
}
function zoomBy(factor, cx, cy) {
  if (cx == null) { const r = lbImg.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  zoomAt(cx, cy, scale * factor);
}

function show(i) {
  if (!items.length) return;
  idx = (i + items.length) % items.length;
  const it = items[idx];
  scale = 1; tx = 0; ty = 0;
  curRot = it.rot || 0;
  baseFit = 1;
  lbImg.onload = function () { computeFit(); applyTransform(); };
  lbImg.src = it.src;
  lbImg.alt = it.cap || 'Foto';
  lbCap.textContent = it.cap || '';
  applyTransform();
  if (lbDownload) {
    if (it.id) { lbDownload.href = '/download/foto/' + it.id; lbDownload.style.display = ''; }
    else { lbDownload.style.display = 'none'; }
  }
  const many = items.length > 1;
  if (lbPrev) lbPrev.style.display = many ? '' : 'none';
  if (lbNext) lbNext.style.display = many ? '' : 'none';
}
function openLightbox(i) {
  show(i);
  if (lb) lb.classList.add('open');
  document.body.style.overflow = 'hidden';
  if (lbClose) lbClose.focus();
}
function closeLightbox() {
  if (lb) lb.classList.remove('open');
  resetZoom();
  if (lbImg) lbImg.src = '';
  document.body.style.overflow = '';
}
function next() { show(idx + 1); }
function prev() { show(idx - 1); }

const mounts = [...document.querySelectorAll('.mount.has-photo')];
items = mounts.map((el) => ({ src: el.dataset.src, cap: el.dataset.cap || '', id: el.dataset.id || '', rot: parseInt(el.dataset.rot || '0', 10) || 0 }));
mounts.forEach((el, i) => {
  el.addEventListener('click', () => openLightbox(i));
  const img = el.querySelector('img');
  if (img) img.addEventListener('error', () => {
    el.classList.remove('has-photo');
    el.classList.add('empty');
    el.disabled = true;
    const frame = el.querySelector('.frame');
    if (frame) frame.innerHTML =
      '<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span><div class="ph">Niet gevonden</div>';
  });
});

if (lbClose) lbClose.addEventListener('click', closeLightbox);
if (lbPrev) lbPrev.addEventListener('click', (e) => { e.stopPropagation(); prev(); });
if (lbNext) lbNext.addEventListener('click', (e) => { e.stopPropagation(); next(); });
if (lbZoomIn) lbZoomIn.addEventListener('click', (e) => { e.stopPropagation(); zoomBy(1.4); });
if (lbZoomOut) lbZoomOut.addEventListener('click', (e) => { e.stopPropagation(); zoomBy(1 / 1.4); });
if (lb) lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

document.addEventListener('keydown', (e) => {
  if (!lb || !lb.classList.contains('open')) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowRight') next();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === '+' || e.key === '=') zoomBy(1.4);
  else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.4);
});

/* Scrollwiel: zoom naar de cursor */
if (lb) lb.addEventListener('wheel', (e) => {
  if (!lb.classList.contains('open')) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}, { passive: false });

/* Dubbelklik: in-/uitzoomen */
if (lbImg) lbImg.addEventListener('dblclick', (e) => {
  e.preventDefault();
  if (scale > 1) resetZoom(); else zoomAt(e.clientX, e.clientY, 2.5);
});

/* Slepen om te verschuiven (ingezoomd) + pinch-zoom op touch */
const pointers = new Map();
let startDist = 0, startScale = 1;
function ptDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function ptMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
if (lbImg) {
  lbImg.addEventListener('pointerdown', (e) => {
    lbImg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const p = [...pointers.values()]; startDist = ptDist(p[0], p[1]); startScale = scale; }
    if (scale > 1) lbImg.classList.add('dragging');
  });
  lbImg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      if (scale > 1) { tx += e.clientX - prev.x; ty += e.clientY - prev.y; applyTransform(); }
    } else if (pointers.size === 2) {
      const p = [...pointers.values()];
      const d = ptDist(p[0], p[1]), m = ptMid(p[0], p[1]);
      if (startDist > 0) zoomAt(m.x, m.y, startScale * (d / startDist));
    }
  });
  function endPointer(e) {
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
    if (pointers.size < 2) startDist = 0;
    if (pointers.size === 0) lbImg.classList.remove('dragging');
  }
  lbImg.addEventListener('pointerup', endPointer);
  lbImg.addEventListener('pointercancel', endPointer);
}

/* Reveal on scroll */
const io = new IntersectionObserver((entries) => {
  entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal, .year-head').forEach((el) => { el.classList.add('reveal'); io.observe(el); });

/* Active year in the spine nav */
const links = [...document.querySelectorAll('.spine a[data-year]')];
if (links.length) {
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        const id = en.target.id.replace('jaar-', '');
        links.forEach((l) => l.classList.toggle('is-active', l.dataset.year === id));
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('.year').forEach((s) => spy.observe(s));
}
