'use strict';
/**
 * Fase 2 — OFFLINE gezichtsdetectie.
 *
 * Draai dit op je eigen Mac (NIET op de server). Het haalt elke foto op,
 * detecteert de gezichten en schrijft seed/faces.json. Dat bestand commit je
 * mee; de server leest het bij opstart in als nog-naamloze gezichten, die je
 * daarna op de site (Beheer → Gezichten) aan personen koppelt.
 *
 * Installeren (eenmalig, blijft buiten package.json):
 *   npm install --no-save @tensorflow/tfjs @tensorflow/tfjs-backend-wasm @vladmandic/face-api jpeg-js
 *
 * Draaien:
 *   node scripts/scan-faces.js                # alle foto's (nauwkeurig: ssd)
 *   node scripts/scan-faces.js --limit 5      # eerst even testen op 5 foto's
 *   node scripts/scan-faces.js --min 0.5      # detectiedrempel (0–1, standaard 0.4)
 *   node scripts/scan-faces.js --detector tiny  # sneller, minder nauwkeurig
 *
 * Geen native build nodig (pure JS), dus werkt op elke Node-versie.
 */

const fs = require('fs');
const path = require('path');

function need(mod) {
  try { return require(mod); }
  catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && e.message.indexOf(mod) === -1) throw e;
    console.error('\nOntbrekende module "' + mod + '". Installeer eerst:\n' +
      '  npm install --no-save @tensorflow/tfjs @tensorflow/tfjs-backend-wasm @vladmandic/face-api jpeg-js\n');
    process.exit(1);
  }
}

const tf = need('@tensorflow/tfjs');
const wasm = need('@tensorflow/tfjs-backend-wasm');
// Native-vrije build van face-api die onze tfjs + WASM-backend gebruikt.
const faceapi = need('@vladmandic/face-api/dist/face-api.node-wasm.js');
const jpeg = need('jpeg-js');
const { db } = require('../db.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const MIN = parseFloat(arg('min', '0.4')) || 0.4;
const DETECTOR = (arg('detector', 'ssd') === 'tiny') ? 'tiny' : 'ssd';

function modelDir() {
  // @vladmandic/face-api levert de modelgewichten mee in /model.
  const pkg = require.resolve('@vladmandic/face-api/package.json');
  const dir = path.join(path.dirname(pkg), 'model');
  if (!fs.existsSync(dir)) {
    console.error('Modelmap niet gevonden op ' + dir);
    process.exit(1);
  }
  return dir;
}

// JPEG-buffer -> tensor3d [hoogte, breedte, 3] met waarden 0–255.
function decodeJpegToTensor(buf) {
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const { width, height, data } = img; // data is RGBA
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
  }
  return tf.tensor3d(rgb, [height, width, 3]);
}

async function fetchBuffer(src) {
  if (src.startsWith('/uploads/')) {
    const p = path.join(__dirname, '..', 'data', src.replace(/^\//, ''));
    return fs.readFileSync(p);
  }
  const r = await fetch(src);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function isJpeg(src) { return /\.(jpe?g)(\?|#|$)/i.test(src); }

async function main() {
  const wasmDir = path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist') + path.sep;
  wasm.setWasmPaths(wasmDir);
  await tf.setBackend('wasm');
  await tf.ready();
  console.log('TF-backend: ' + tf.getBackend());
  const dir = modelDir();
  console.log('Modellen laden uit ' + dir + ' … (detector: ' + DETECTOR + ')');
  if (DETECTOR === 'ssd') await faceapi.nets.ssdMobilenetv1.loadFromDisk(dir);
  else await faceapi.nets.tinyFaceDetector.loadFromDisk(dir);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(dir);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(dir);

  let photos = db.prepare('SELECT id, src, caption FROM photos WHERE deleted = 0 ORDER BY id ASC').all();
  if (LIMIT) photos = photos.slice(0, LIMIT);
  console.log(photos.length + ' foto\'s scannen (detectiedrempel ' + MIN + ') …\n');

  const options = (DETECTOR === 'ssd')
    ? new faceapi.SsdMobilenetv1Options({ minConfidence: MIN })
    : new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: MIN });
  const out = [];
  let done = 0, faceTotal = 0, skipped = 0;

  for (const ph of photos) {
    done++;
    const tag = '[' + done + '/' + photos.length + '] ' + ph.src.split('/').pop();
    if (!isJpeg(ph.src)) { console.log(tag + ' — overgeslagen (geen JPEG)'); skipped++; continue; }
    let tensor;
    try {
      const buf = await fetchBuffer(ph.src);
      tensor = decodeJpegToTensor(buf);
    } catch (e) {
      console.log(tag + ' — overgeslagen (' + e.message + ')'); skipped++; continue;
    }
    try {
      const [h, w] = tensor.shape;
      const results = await faceapi
        .detectAllFaces(tensor, options)
        .withFaceLandmarks()
        .withFaceDescriptors();
      for (const r of results) {
        const b = r.detection.box;
        out.push({
          src: ph.src,
          x: +(b.x / w).toFixed(4),
          y: +(b.y / h).toFixed(4),
          w: +(b.width / w).toFixed(4),
          h: +(b.height / h).toFixed(4),
          score: +r.detection.score.toFixed(3),
          descriptor: Array.from(r.descriptor).map((v) => +v.toFixed(4))
        });
      }
      faceTotal += results.length;
      console.log(tag + ' — ' + results.length + ' gezicht(en)');
    } catch (e) {
      console.log(tag + ' — detectie mislukt (' + e.message + ')'); skipped++;
    } finally {
      if (tensor) tensor.dispose();
    }
  }

  const seedDir = path.join(__dirname, '..', 'seed');
  fs.mkdirSync(seedDir, { recursive: true });
  const file = path.join(seedDir, 'faces.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    model: 'tinyFaceDetector+recognition',
    minScore: MIN,
    photos: photos.length,
    faces: out
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 1));
  console.log('\nKlaar: ' + faceTotal + ' gezichten over ' + (photos.length - skipped) +
    ' foto\'s (' + skipped + ' overgeslagen).');
  console.log('Geschreven naar ' + path.relative(path.join(__dirname, '..'), file));
  console.log('Commit dit bestand; de server importeert het bij de volgende opstart.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
