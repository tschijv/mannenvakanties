'use strict';

/**
 * Importeert offline gedetecteerde gezichten (seed/faces.json) in de database.
 * Draait bij opstart vanuit db.js. Idempotent: per foto-bron (src) wordt
 * onthouden dat hij al ingelezen is, dus herstarten voegt niets dubbel toe en
 * respecteert gezichten die je later met de hand hebt verwijderd.
 *
 * Geïmporteerde gezichten zijn nog NIET aan een persoon gekoppeld
 * (person_id = NULL, source = 'auto'); dat doe je op de site bij
 * Beheer → Gezichten.
 */

const fs = require('fs');
const path = require('path');

function importFaceSeed(db) {
  const file = path.join(__dirname, 'seed', 'faces.json');
  if (!fs.existsSync(file)) return;

  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('Gezichten-seed: kon faces.json niet lezen —', e.message); return; }
  if (!data || !Array.isArray(data.faces)) return;

  db.exec(
    "CREATE TABLE IF NOT EXISTS face_scan (" +
    "  src TEXT PRIMARY KEY," +
    "  faces INTEGER NOT NULL DEFAULT 0," +
    "  imported_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ");"
  );

  const bySrc = new Map();
  for (const f of data.faces) {
    if (!f || !f.src) continue;
    if (!bySrc.has(f.src)) bySrc.set(f.src, []);
    bySrc.get(f.src).push(f);
  }

  const getPhoto = db.prepare('SELECT id FROM photos WHERE src = ? AND deleted = 0');
  const seen = db.prepare('SELECT 1 AS x FROM face_scan WHERE src = ?');
  const mark = db.prepare('INSERT OR REPLACE INTO face_scan (src, faces) VALUES (?, ?)');
  const ins = db.prepare(
    'INSERT INTO faces (photo_id, person_id, x, y, w, h, source, descriptor) ' +
    'VALUES (?, NULL, ?, ?, ?, ?, ?, ?)'
  );

  let added = 0, srcsDone = 0;
  const tx = db.transaction(() => {
    for (const [src, faces] of bySrc) {
      if (seen.get(src)) continue;          // al eerder ingelezen
      const photo = getPhoto.get(src);
      if (!photo) continue;                 // foto (nog) niet in deze database — later opnieuw proberen
      for (const f of faces) {
        ins.run(photo.id, f.x, f.y, f.w, f.h, 'auto', f.descriptor ? JSON.stringify(f.descriptor) : null);
        added++;
      }
      mark.run(src, faces.length);
      srcsDone++;
    }
  });
  tx();

  if (added) console.log('Gezichten-seed: ' + added + ' gezichten geïmporteerd over ' + srcsDone + " foto's.");
}

module.exports = { importFaceSeed };
