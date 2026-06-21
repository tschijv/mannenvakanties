'use strict';

/**
 * Server-side gezichtsdetectie (op aanvraag via een knop).
 * Scant foto's die nog niet eerder gescand zijn (ook nieuwe uploads),
 * en zet gevonden gezichten klaar als nog-naamloze gezichten in de namer.
 *
 * Native-vrij: tfjs WASM-backend + @vladmandic/face-api + jpeg-js.
 * Draait "fire-and-forget" op de achtergrond; tussen foto's geven we de
 * event-loop lucht zodat de site bereikbaar blijft.
 */

const fs = require('fs');
const path = require('path');

let _tf = null, _wasm = null, _faceapi = null, _jpeg = null, _modelsReady = false;

const state = {
  running: false, total: 0, done: 0, added: 0, skipped: 0,
  startedAt: null, finishedAt: null, error: null, current: ''
};

function getState() { return Object.assign({}, state); }

function loadDeps() {
  if (_faceapi) return;
  try {
    _tf = require('@tensorflow/tfjs');
    _wasm = require('@tensorflow/tfjs-backend-wasm');
    _faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    _jpeg = require('jpeg-js');
  } catch (e) {
    throw new Error('Detectiebibliotheken ontbreken op de server — draai "npm install" en herstart. (' + e.message + ')');
  }
  const wasmDir = path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist') + path.sep;
  _wasm.setWasmPaths(wasmDir);
}

async function ensureReady() {
  loadDeps();
  if (_modelsReady) return;
  await _tf.setBackend('wasm');
  await _tf.ready();
  const dir = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
  await _faceapi.nets.ssdMobilenetv1.loadFromDisk(dir);
  await _faceapi.nets.faceLandmark68Net.loadFromDisk(dir);
  await _faceapi.nets.faceRecognitionNet.loadFromDisk(dir);
  _modelsReady = true;
}

function decodeJpegToTensor(buf) {
  const img = _jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const { width, height, data } = img;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2]; }
  return _tf.tensor3d(rgb, [height, width, 3]);
}

async function fetchBuffer(src, dataDir) {
  if (src.startsWith('/uploads/')) return fs.readFileSync(path.join(dataDir, src.replace('/uploads/', 'uploads/')));
  const r = await fetch(src);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

const isJpeg = (src) => /\.(jpe?g)(\?|#|$)/i.test(src);
const yieldLoop = () => new Promise((r) => setImmediate(r));

// Start een scan (als er nog geen loopt). Retourneert direct; werk gebeurt op de achtergrond.
function startScan(db, dataDir, opts) {
  const minScore = (opts && opts.minScore) || 0.4;
  if (state.running) return getState();
  Object.assign(state, { running: true, total: 0, done: 0, added: 0, skipped: 0, startedAt: Date.now(), finishedAt: null, error: null, current: 'Modellen laden…' });

  (async () => {
    try {
      await ensureReady();
      db.exec("CREATE TABLE IF NOT EXISTS face_scan (src TEXT PRIMARY KEY, faces INTEGER NOT NULL DEFAULT 0, imported_at TEXT NOT NULL DEFAULT (datetime('now')));");
      const photos = db.prepare(
        'SELECT id, src FROM photos WHERE deleted = 0 AND src NOT IN (SELECT src FROM face_scan) ORDER BY id ASC'
      ).all();
      state.total = photos.length;

      const options = new _faceapi.SsdMobilenetv1Options({ minConfidence: minScore });
      const ins = db.prepare('INSERT INTO faces (photo_id, person_id, x, y, w, h, source, descriptor) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)');
      const mark = db.prepare('INSERT OR REPLACE INTO face_scan (src, faces) VALUES (?, ?)');

      for (const ph of photos) {
        state.current = ph.src.split('/').pop();
        if (!isJpeg(ph.src)) { mark.run(ph.src, 0); state.skipped++; state.done++; await yieldLoop(); continue; }
        let tensor = null;
        try {
          const buf = await fetchBuffer(ph.src, dataDir);
          tensor = decodeJpegToTensor(buf);
          const [h, w] = tensor.shape;
          const results = await _faceapi.detectAllFaces(tensor, options).withFaceLandmarks().withFaceDescriptors();
          const tx = db.transaction(() => {
            for (const r of results) {
              const b = r.detection.box;
              ins.run(
                ph.id,
                +(b.x / w).toFixed(4), +(b.y / h).toFixed(4),
                +(b.width / w).toFixed(4), +(b.height / h).toFixed(4),
                'auto', JSON.stringify(Array.from(r.descriptor).map((v) => +v.toFixed(4)))
              );
            }
            mark.run(ph.src, results.length);
          });
          tx();
          state.added += results.length;
        } catch (e) {
          try { mark.run(ph.src, 0); } catch (e2) { /* negeren */ }
          state.skipped++;
        } finally {
          if (tensor) tensor.dispose();
        }
        state.done++;
        await yieldLoop();
      }
      state.current = 'Klaar';
    } catch (e) {
      state.error = e.message;
      state.current = 'Mislukt';
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return getState();
}

module.exports = { startScan, getState };
