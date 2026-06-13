'use strict';

/* Lightbox */
const lb = document.getElementById('lightbox');
const lbImg = document.getElementById('lbImg');
const lbCap = document.getElementById('lbCap');
const lbClose = document.getElementById('lbClose');

function openLightbox(src, cap) {
  lbImg.src = src;
  lbImg.alt = cap || 'Foto';
  lbCap.textContent = cap || '';
  lb.classList.add('open');
  document.body.style.overflow = 'hidden';
  lbClose.focus();
}
function closeLightbox() {
  lb.classList.remove('open');
  lbImg.src = '';
  document.body.style.overflow = '';
}

document.querySelectorAll('.mount.has-photo').forEach((el) => {
  el.addEventListener('click', () => openLightbox(el.dataset.src, el.dataset.cap || ''));
  // val een foto weg, toon dan netjes een lege plek
  const img = el.querySelector('img');
  if (img) img.addEventListener('error', () => {
    el.classList.remove('has-photo');
    el.classList.add('empty');
    el.disabled = true;
    el.querySelector('.frame').innerHTML =
      '<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span><div class="ph">Niet gevonden</div>';
  });
});

if (lbClose) lbClose.addEventListener('click', closeLightbox);
if (lb) lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

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
