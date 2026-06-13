'use strict';

/**
 * Database: SQLite via better-sqlite3.
 * Maakt de tabellen aan en vult bij een lege database de drie bestaande
 * jaren (1997, 2003, 2009) met de foto's die nu nog op xs4all staan.
 */

const path = require('path');
const fs = require('fs');
const { createDb } = require('./database');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = createDb(path.join(DATA_DIR, 'app.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS years (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  year       TEXT NOT NULL,
  place      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  year_id     INTEGER NOT NULL,
  src         TEXT NOT NULL,
  caption     TEXT NOT NULL DEFAULT '',
  uploaded_by INTEGER,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (year_id)     REFERENCES years(id)  ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)  ON DELETE SET NULL
);
`);

/* ------------------------------------------------------------------ */
/*  Migratie: kolommen voor 'zacht verwijderen' (herstelbaar)          */
/* ------------------------------------------------------------------ */
function ensureColumn(table, column, definition) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (!cols.some((c) => c.name === column)) {
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  }
}
ensureColumn('photos', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('photos', 'deleted_at', 'TEXT');
ensureColumn('photos', 'deleted_by', 'INTEGER');

/* Coördinaten per jaar, voor de kaart-ingang (mogen leeg zijn) */
ensureColumn('years', 'lat', 'REAL');
ensureColumn('years', 'lng', 'REAL');

/* ------------------------------------------------------------------ */
/*  Seed: de drie bestaande jaren (alleen als 'years' nog leeg is)     */
/* ------------------------------------------------------------------ */

function xs(folder, file, ext) {
  const BASE = 'https://tschijv.home.xs4all.nl/Mannenvakanties/Fotos/';
  return BASE + folder + '/slides/' + encodeURIComponent(file) + '.' + (ext || 'jpg');
}

function reeks2009() {
  const out = [];
  for (let i = 1; i <= 62; i++) {
    out.push({ file: 'Mannenvakantie 2009 ' + String(i).padStart(3, '0'), caption: '' });
  }
  return out;
}

const SEED = [
  {
    year: '1997',
    place: 'Spa · Moulin du Rahier',
    note: 'De Ardennen als nieuwe pleisterplaats — een molen, een dorp, en alle tijd.',
    folder: '1997%20-%20Spa,%20Moulin%20du%20Rahier',
    lat: 50.2861, lng: 5.7806,
    photos: [
      '4117731889_5fa82dcb44_o','4117732177_947df0d148_o','4117732329_68a529c111_o',
      '4117732479_131069c300_o','4117732927_b00426cc56_o','4117733257_1cd22a659f_o',
      '4117733781_3e02c77e91_o','4117733927_cb4c175110_o','4118499744_4b822fee50_o',
      '4118500974_6ecb934254_o','4118501090_dbd00b9a04_o','4118502034_8bbbe25010_o',
      '4118502570_e12666f096_o','4118502998_0f218616be_o','4118503158_025f106a6e_o',
      '4118503586_f51c2b51fe_o','4118503880_6ca726eb12_o','4118504088_23a55e7bfc_o',
      '4117730391_63f36857f2_o','4117730623_f7fb3cdb5f_o','4117730771_f21018c0cd_o',
      '4117731047_b74ab66edf_o','4117731313_9e8940d6a3_o'
    ].map(f => ({ file: f, caption: '' }))
  },
  {
    year: '2003',
    place: 'Verdun',
    note: 'Tussen de slagvelden en forten — het verleden waar de mannen het ooit om begonnen.',
    folder: '2003%20-%20Verdun',
    lat: 49.1599, lng: 5.3828,
    photos: [
      { file: 'Image-DB031F07A40511D7', caption: '' },
      { file: 'Image-DB03BBFAA40511D7', caption: '' },
      { file: 'Image-DB0315B0A40511D7', caption: '' },
      { file: 'keesIMGP0083',          caption: 'Kees',           ext: 'JPG' },
      { file: 'antonIMGP00841',         caption: 'Anton',          ext: 'JPG' },
      { file: 'stefanIMGP0085',         caption: 'Stefan',         ext: 'JPG' },
      { file: 'mannenIMGP0090',         caption: 'De mannen',      ext: 'JPG' },
      { file: 'ondergrondIMGP0081',     caption: 'Ondergronds',    ext: 'JPG' },
      { file: 'stefansonnyIMGP0082',    caption: 'Stefan & Sonny', ext: 'JPG' },
      { file: 'stefanbasIMGP0086',      caption: 'Stefan & Bas',   ext: 'JPG' },
      { file: 'momentomoriIMGP0088',    caption: 'Memento mori',   ext: 'JPG' },
      { file: 'rikIMGP0098',            caption: 'Rik',            ext: 'JPG' },
      { file: 'rikmetflesIMGP0102',     caption: 'Rik met fles',   ext: 'JPG' },
      { file: 'sonnymetflesIMGP0103',   caption: 'Sonny met fles', ext: 'JPG' },
      { file: 'redeyehancoIMGP0110',    caption: 'Hanco',          ext: 'JPG' },
      { file: 'moderneheldenIMGP0120',  caption: 'Moderne helden', ext: 'JPG' },
      { file: 'smoke-earantonIMGP0115', caption: 'Anton',          ext: 'JPG' }
    ]
  },
  {
    year: '2009',
    place: 'Waimes',
    note: 'Terug in de Ardennen — inmiddels een ingespeelde traditie, en de grootste reeks.',
    folder: '2009%20-%20Waimes',
    lat: 50.4150, lng: 6.1108,
    photos: reeks2009()
  }
];

function seed() {
  const insYear = db.prepare('INSERT INTO years (year, place, note, lat, lng) VALUES (?, ?, ?, ?, ?)');
  const insPhoto = db.prepare('INSERT INTO photos (year_id, src, caption, sort) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    for (const y of SEED) {
      const { lastInsertRowid } = insYear.run(y.year, y.place, y.note, y.lat ?? null, y.lng ?? null);
      y.photos.forEach((p, i) => insPhoto.run(lastInsertRowid, xs(y.folder, p.file, p.ext), p.caption, i));
    }
  });
  tx();
}

if (db.prepare('SELECT COUNT(*) AS n FROM years').get().n === 0) {
  seed();
  console.log('Database gevuld met de drie bestaande jaren.');
}

// Backfill: zet coördinaten voor de drie oorspronkelijke jaren als ze nog leeg zijn
// (zodat bestaande databases ook meteen op de kaart verschijnen).
{
  const setCoords = db.prepare('UPDATE years SET lat = ?, lng = ? WHERE year = ? AND lat IS NULL');
  for (const y of SEED) if (y.lat != null) setCoords.run(y.lat, y.lng, y.year);
}

// Eenmalige reparatie: de IMGP-foto's van 2003 Verdun staan op de server als .JPG
// (hoofdletters). Oudere databases hadden hier .jpg en laadden daardoor niet.
// Deze update is idempotent (raakt alleen nog-niet-herstelde regels).
db.prepare(
  "UPDATE photos SET src = substr(src, 1, length(src) - 4) || '.JPG' " +
  "WHERE src LIKE '%Verdun/slides/%IMGP%.jpg' AND src NOT GLOB '*.JPG'"
).run();

module.exports = { db, DATA_DIR, UPLOAD_DIR };
