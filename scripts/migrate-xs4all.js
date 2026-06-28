'use strict';

/**
 * Eenmalige migratie: haal de nog-externe foto's (xs4all) binnen en sla ze
 * lokaal op in data/uploads, zodat ze blijven werken als xs4all offline gaat.
 *
 * Draaien op de SERVER, als de app-gebruiker (zodat bestanden goed eigenaar zijn):
 *   cd /var/www/mannenvakanties
 *   runuser -u mannen -- node scripts/migrate-xs4all.js
 *
 * Idempotent: alleen foto's waarvan de src nog niet op /uploads/ staat worden
 * verwerkt. Mislukt er één, dan blijft die extern en kun je het script opnieuw draaien.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

function extFromSrc(src) {
  const m = String(src || '').match(/\.([A-Za-z0-9]{1,5})(?:\?|#|$)/);
  const e = m ? m[1].toLowerCase() : 'jpg';
  return /^(jpe?g|png|gif|webp|heic|heif)$/.test(e) ? e : 'jpg';
}

async function main() {
  const db = new Database(path.join(DATA_DIR, 'app.db'));
  db.pragma('busy_timeout = 10000');
  const rows = db.prepare("SELECT id, year_id, src FROM photos WHERE deleted = 0 AND src NOT LIKE '/uploads/%'").all();
  console.log(rows.length + " externe foto's te migreren\n");
  const upd = db.prepare('UPDATE photos SET src = ? WHERE id = ?');

  let ok = 0, fail = 0;
  for (const p of rows) {
    try {
      const r = await fetch(p.src, { redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('leeg bestand');
      const dir = path.join(UPLOAD_DIR, String(p.year_id));
      fs.mkdirSync(dir, { recursive: true });
      const name = crypto.randomBytes(10).toString('hex') + '.' + extFromSrc(p.src);
      fs.writeFileSync(path.join(dir, name), buf);
      upd.run('/uploads/' + p.year_id + '/' + name, p.id);
      ok++;
      console.log('✓ #' + p.id + '  ' + (buf.length / 1024 | 0) + ' KB  → /uploads/' + p.year_id + '/' + name);
    } catch (e) {
      fail++;
      console.log('✗ #' + p.id + '  ' + p.src + '  — ' + e.message);
    }
  }
  console.log('\nKlaar: ' + ok + ' gemigreerd, ' + fail + ' mislukt.');
  const rest = db.prepare("SELECT COUNT(*) AS n FROM photos WHERE deleted = 0 AND src NOT LIKE '/uploads/%'").get().n;
  console.log('Nog extern: ' + rest);
  db.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
