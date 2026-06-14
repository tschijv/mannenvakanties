'use strict';

/* Lightbox met bladeren */
const lb = document.getElementById('lightbox');
const lbImg = document.getElementById('lbImg');
const lbCap = document.getElementById('lbCap');
const lbClose = document.getElementById('lbClose');
const lbPrev = document.getElementById('lbPrev');
const lbNext = document.getElementById('lbNext');
const lbDownload = document.getElementById('lbDownload');

let items = [];
let idx = -1;

function show(i) {
  if (!items.length) return;
  idx = (i + items.length) % items.length;
  const it = items[idx];
  lbImg.src = it.src;
  lbImg.alt = it.cap || 'Foto';
  lbCap.textContent = it.cap || '';
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
  if (lbImg) lbImg.src = '';
  document.body.style.overflow = '';
}
function next() { show(idx + 1); }
function prev() { show(idx - 1); }

const mounts = [...document.querySelectorAll('.mount.has-photo')];
items = mounts.map((el) => ({ src: el.dataset.src, cap: el.dataset.cap || '', id: el.dataset.id || '' }));
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
if (lb) lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
document.addEventListener('keydown', (e) => {
  if (!lb || !lb.classList.contains('open')) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowRight') next();
  else if (e.key === 'ArrowLeft') prev();
});

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
