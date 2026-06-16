'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('./sqlite-session-store')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const archiver = require('archiver');

const { db, UPLOAD_DIR } = require('./db');

const app = express();
app.locals.ASSET_VER = String(Date.now()); // verandert bij elke (her)start, dwingt verse CSS/JS af
const PORT = process.env.PORT || 3000;

// Vaste beheerders: namen uit ADMIN_USERS (komma-gescheiden) zijn altijd admin.
// Bijvoorbeeld in de systemd-service: Environment=ADMIN_USERS=Toine,Anton
const ADMIN_USERS = (process.env.ADMIN_USERS || 'Toine,Anton')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
function isDesignatedAdmin(username) {
  return ADMIN_USERS.includes(String(username || '').trim().toLowerCase());
}

// Toegangsvraag bij het aanmelden: alleen wie het antwoord weet, mag lid worden.
// Antwoorden worden genormaliseerd (kleine letters, accenten weg), zodat
// "Moldavië" en "Moldavie" allebei goed zijn.
function normAnswer(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
const JOIN_ANSWER = normAnswer(process.env.JOIN_ANSWER || 'Moldavië');

// Logboek: leg een gebeurtenis vast (wie deed wat). kind: 'content' | 'lid' | 'beheer'.
function addLog(username, event, kind) {
  try { db.prepare('INSERT INTO logs (username, event, kind) VALUES (?, ?, ?)').run(username || 'onbekend', event, kind || 'content'); } catch (e) { /* logging mag nooit de actie blokkeren */ }
}
function actor(res) { return (res.locals.user && res.locals.user.username) ? res.locals.user.username : 'onbekend'; }
function yearLabel(id) { const y = db.prepare('SELECT year FROM years WHERE id = ?').get(id); return y ? y.year : ('jaar ' + id); }
// Bij opstarten: bestaande gebruikers met zo'n naam alsnog beheerder maken.
if (ADMIN_USERS.length) {
  const promote = db.prepare("UPDATE users SET role = 'admin' WHERE lower(username) = ? AND role <> 'admin'");
  for (const name of ADMIN_USERS) promote.run(name);
}

// Achter een reverse proxy (nginx/Apache met https): vertrouw de proxy,
// anders worden 'secure' sessiecookies niet verstuurd en lukt inloggen niet.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

/* ------------------------------------------------------------------ */
/*  Basis                                                              */
/* ------------------------------------------------------------------ */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

app.use(session({
  store: new SqliteStore(db),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // zet NODE_ENV=production achter https
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

/* huidige gebruiker + csrf-token beschikbaar in elke view */
app.use((req, res, next) => {
  res.locals.user = req.session.userId
    ? db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.session.userId)
    : null;
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

/* ------------------------------------------------------------------ */
/*  Bezoekcijfers: leg paginaweergaves vast (geen IP, geen tracking)   */
/* ------------------------------------------------------------------ */
// Alleen echte pagina's tellen — geen assets, beheeracties, downloads of in-/uitloggen.
const VISIT_SKIP = /^\/(uploads|beheer|download|inloggen|aanmelden|uitloggen|favicon|robots|styles|gallery|kaart\.js|beheer\.js)/;
const BOT_UA = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|preview|monitor|curl|wget|python-requests|headless/i;

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

const insVisit = db.prepare('INSERT INTO visits (path, year_id, username, visitor) VALUES (?, ?, ?, ?)');
app.use((req, res, next) => {
  try {
    if (req.method === 'GET' && !VISIT_SKIP.test(req.path) &&
        (req.headers.accept || '').includes('text/html') &&
        !BOT_UA.test(req.headers['user-agent'] || '')) {
      // anonieme bezoeker-sleutel via lichte first-party cookie (geen persoonsgegevens)
      let vid = readCookie(req, 'mv_vid');
      if (!vid) {
        vid = crypto.randomBytes(8).toString('hex');
        res.cookie('mv_vid', vid, {
          httpOnly: true, sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          maxAge: 1000 * 60 * 60 * 24 * 365
        });
      }
      const ym = req.path.match(/^\/jaar\/(\d+)/);
      const username = (res.locals.user && res.locals.user.username) || null;
      insVisit.run(req.path, ym ? Number(ym[1]) : null, username, vid);
    }
  } catch (e) { /* tellen mag nooit een pagina blokkeren */ }
  next();
});

function checkCsrf(req, res) {
  const token = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  if (token !== req.session.csrf) {
    res.status(403).send('Sessie verlopen of ongeldig. Ga terug, ververs de pagina en probeer opnieuw.');
    return false;
  }
  return true;
}

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    req.session.flash = { type: 'info', msg: 'Log eerst in om te kunnen beheren.' };
    return res.redirect('/inloggen');
  }
  next();
}

function canEdit(user, ownerId) {
  return user && (user.role === 'admin' || user.id === ownerId);
}

/* ------------------------------------------------------------------ */
/*  Uploads                                                            */
/* ------------------------------------------------------------------ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.jpg'])[0];
    cb(null, crypto.randomBytes(10).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 200 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|gif|webp|heic|heif)$/.test(file.mimetype))
});

/* ------------------------------------------------------------------ */
/*  Helpers om jaren + foto's op te halen                              */
/* ------------------------------------------------------------------ */
function yearsOverview() {
  return db.prepare(
    'SELECT y.*, ' +
    '(SELECT COUNT(*) FROM photos p WHERE p.year_id = y.id AND p.deleted = 0) AS photo_count, ' +
    '(SELECT p.src FROM photos p WHERE p.year_id = y.id AND p.deleted = 0 ORDER BY p.sort ASC, p.id ASC LIMIT 1) AS cover ' +
    'FROM years y ORDER BY y.year ASC, y.id ASC'
  ).all();
}

function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

// Haal het 11-teken YouTube-id uit allerlei linkvormen (watch?v=, youtu.be/, embed/, shorts/, of kaal id).
function youtubeId(url) {
  const s = String(url == null ? '' : url).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/); if (m) return m[1];
  m = s.match(/(?:youtu\.be\/|\/embed\/|\/shorts\/|\/live\/|\/v\/)([A-Za-z0-9_-]{11})/); if (m) return m[1];
  return null;
}

// Sleutel om dubbele foto's te herkennen: inhoud-hash voor lokale uploads, anders de bron-URL.
function photoKey(p) {
  if (p.src && p.src.startsWith('/uploads/')) {
    try {
      const fp = path.join(__dirname, 'data', p.src.replace('/uploads/', 'uploads/'));
      return 'h:' + crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
    } catch (e) { return 'src:' + p.src; }
  }
  return 'src:' + (p.src || ('id:' + p.id));
}

// EXIF-oriëntatie (1-8) van een JPEG uitlezen. Geen EXIF / ander formaat / fout -> 1.
function exifOrientation(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd); fd = undefined;
    if (read < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return 1;
    let off = 2;
    while (off + 4 <= read) {
      if (buf[off] !== 0xFF) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xDA || marker === 0xD9) break;
      const size = buf.readUInt16BE(off + 2);
      if (marker === 0xE1 && buf.toString('ascii', off + 4, off + 8) === 'Exif') {
        const tiff = off + 10;
        const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
        const r16 = (o) => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
        const r32 = (o) => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
        const ifd0 = tiff + r32(tiff + 4);
        if (ifd0 + 2 > read) return 1;
        const n = r16(ifd0);
        for (let i = 0; i < n; i++) {
          const e = ifd0 + 2 + i * 12;
          if (e + 12 > read) break;
          if (r16(e) === 0x0112) return r16(e + 8) || 1;
        }
        return 1;
      }
      off += 2 + size;
    }
    return 1;
  } catch (x) { try { if (fd !== undefined) fs.closeSync(fd); } catch (y) {} return 1; }
}
// EXIF-oriëntatie -> graden die wij draaien om de foto rechtop te tonen.
function orientationToRotation(o) {
  return ({ 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 })[o] || 0;
}

/* ------------------------------------------------------------------ */
/*  Publieke ingangen: tijdlijn, kaart, en losse jaar-pagina's         */
/* ------------------------------------------------------------------ */
app.get('/', (req, res) => {
  res.render('tijdlijn', { years: yearsOverview() });
});

app.get('/kaart', (req, res) => {
  const years = yearsOverview().filter((y) => y.lat != null && y.lng != null);
  res.render('kaart', { years });
});

/* Groepsfoto's: de per jaar aangewezen foto, op jaar gesorteerd */
function groupPhotos() {
  return db.prepare(
    'SELECT y.id AS year_id, y.year, y.place, p.id AS photo_id, p.src, p.caption, p.rotation, p.oriented ' +
    'FROM years y JOIN photos p ON p.id = y.group_photo_id ' +
    'WHERE p.deleted = 0 ORDER BY y.year ASC, y.id ASC'
  ).all();
}

app.get('/groepsfotos', (req, res) => {
  res.render('groepsfotos', { groups: groupPhotos() });
});

/* Recente wijzigingen: album-veranderingen en nieuwe leden, voor iedereen zichtbaar */
app.get('/recent', (req, res) => {
  const changes = db.prepare("SELECT created_at, username, event FROM logs WHERE kind IN ('content','lid') ORDER BY id DESC LIMIT 100").all();
  res.render('recent', { changes });
});

/* ------------------------------------------------------------------ */
/*  Ingang op naam: personen + gezichten (alleen voor leden)           */
/* ------------------------------------------------------------------ */

// Representatief gezicht van een persoon, met fotobron erbij.
// Zelfgekozen omslag (cover_face_id) gaat voor; anders het grootste vlak.
function personCover(personId) {
  const person = db.prepare('SELECT cover_face_id FROM persons WHERE id = ?').get(personId);
  if (person && person.cover_face_id) {
    const chosen = db.prepare(
      'SELECT f.*, p.src, p.rotation, p.oriented FROM faces f JOIN photos p ON p.id = f.photo_id ' +
      'WHERE f.id = ? AND f.person_id = ? AND p.deleted = 0'
    ).get(person.cover_face_id, personId);
    if (chosen) return chosen;
  }
  return db.prepare(
    'SELECT f.*, p.src, p.rotation, p.oriented FROM faces f JOIN photos p ON p.id = f.photo_id ' +
    'WHERE f.person_id = ? AND p.deleted = 0 ORDER BY (f.w * f.h) DESC, f.id ASC LIMIT 1'
  ).get(personId);
}

// Alle personen met aantal foto's en een coverfoto; naamlozen genummerd.
function personsOverview() {
  const persons = db.prepare(
    "SELECT pe.*, " +
    "(SELECT COUNT(*) FROM faces f JOIN photos p ON p.id = f.photo_id " +
    " WHERE f.person_id = pe.id AND p.deleted = 0) AS face_count " +
    "FROM persons pe ORDER BY (pe.name = '') ASC, pe.name COLLATE NOCASE ASC, pe.id ASC"
  ).all();
  let n = 0;
  for (const pe of persons) {
    pe.cover = personCover(pe.id);
    if (!pe.name) pe.seq = ++n;
  }
  return persons;
}

// Personen voor een keuzelijst (gesorteerd, met naamloos-nummer).
function personsForSelect() {
  const persons = db.prepare(
    "SELECT id, name FROM persons ORDER BY (name = '') ASC, name COLLATE NOCASE ASC, id ASC"
  ).all();
  let n = 0;
  for (const pe of persons) pe.label = pe.name || ('Naamloos #' + (++n));
  return persons;
}

function untaggedFaceCount() {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM faces f JOIN photos p ON p.id = f.photo_id ' +
    'WHERE f.person_id IS NULL AND p.deleted = 0'
  ).get().n;
}

// Euclidische afstand tussen twee gezichtskenmerk-vectoren (128 floats).
function faceDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

// Groepeer (greedy) niet-toegewezen gezichten op gelijkenis, grootste groep eerst.
function clusterFaces(faces) {
  const TH = 0.55; // face-api descriptor-drempel; lager = strenger
  const clusters = [];
  for (const f of faces) {
    let d = null;
    if (f.descriptor) { try { d = JSON.parse(f.descriptor); } catch (e) { d = null; } }
    if (!d) { clusters.push({ rep: null, items: [f] }); continue; }
    let best = null, bestDist = Infinity;
    for (const c of clusters) {
      if (!c.rep) continue;
      const dist = faceDistance(d, c.rep);
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    if (best && bestDist < TH) best.items.push(f);
    else clusters.push({ rep: d, items: [f] });
  }
  clusters.sort((a, b) => b.items.length - a.items.length);
  return clusters;
}

app.get('/namen', requireLogin, (req, res) => {
  res.render('namen', { persons: personsOverview(), untagged: untaggedFaceCount() });
});

// Review-inbox: nog niet toegewezen (auto-gedetecteerde) gezichten, op gelijkenis gegroepeerd.
app.get('/beheer/gezichten', requireLogin, (req, res) => {
  const faces = db.prepare(
    'SELECT f.id, f.x, f.y, f.w, f.h, f.descriptor, f.photo_id, p.src, y.year, y.id AS year_id ' +
    'FROM faces f JOIN photos p ON p.id = f.photo_id JOIN years y ON y.id = p.year_id ' +
    'WHERE f.person_id IS NULL AND p.deleted = 0 ORDER BY y.year ASC, p.id ASC, f.id ASC'
  ).all();
  const names = db.prepare("SELECT name FROM persons WHERE name <> '' ORDER BY name COLLATE NOCASE ASC").all().map((r) => r.name);
  res.render('gezichten-review', { groups: clusterFaces(faces), total: faces.length, persons: personsForSelect(), names });
});

// Een groep gezichten in één keer aan een persoon koppelen.
app.post('/beheer/gezichten/groep', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const ids = String(req.body.ids || '').split(',').map((s) => parseInt(s, 10)).filter(Boolean);
  if (!ids.length) return res.redirect('/beheer/gezichten');
  const personId = resolvePerson(req, res, { allowCreate: true });
  if (!personId) {
    req.session.flash = { type: 'err', msg: 'Kies een persoon, vul een naam in, of maak een naamloze persoon.' };
    return res.redirect('/beheer/gezichten');
  }
  const upd = db.prepare('UPDATE faces SET person_id = ? WHERE id = ? AND person_id IS NULL');
  const tx = db.transaction(() => { for (const id of ids) upd.run(personId, id); });
  tx();
  addLog(actor(res), ids.length + ' gezicht(en) toegewezen', 'content');
  res.redirect('/beheer/gezichten');
});

app.get('/persoon/:id', requireLogin, (req, res) => {
  const person = db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.id);
  if (!person) return res.redirect('/namen');
  const faces = db.prepare(
    'SELECT f.*, p.src, p.caption, p.rotation, p.oriented, p.id AS photo_id, ' +
    '       y.id AS year_id, y.year, y.place ' +
    'FROM faces f JOIN photos p ON p.id = f.photo_id JOIN years y ON y.id = p.year_id ' +
    'WHERE f.person_id = ? AND p.deleted = 0 ' +
    'ORDER BY y.year ASC, y.id ASC, p.sort ASC, p.id ASC'
  ).all(person.id);
  const byYear = [];
  const map = {};
  for (const f of faces) {
    if (!map[f.year_id]) { map[f.year_id] = { year_id: f.year_id, year: f.year, place: f.place, items: [] }; byYear.push(map[f.year_id]); }
    map[f.year_id].items.push(f);
  }
  person.cover = personCover(person.id);
  // Andere personen (om mee samen te voegen)
  const others = personsForSelect().filter((p) => p.id !== person.id);
  res.render('persoon', { person, byYear, faceCount: faces.length, others });
});

// Taggen: foto groot tonen met de bestaande gezichten erover.
app.get('/beheer/foto/:id/gezichten', requireLogin, (req, res) => {
  const photo = db.prepare(
    'SELECT p.*, y.id AS year_id, y.year FROM photos p JOIN years y ON y.id = p.year_id ' +
    'WHERE p.id = ? AND p.deleted = 0'
  ).get(req.params.id);
  if (!photo) return res.redirect('/');
  const faces = db.prepare(
    'SELECT f.*, pe.name AS person_name FROM faces f LEFT JOIN persons pe ON pe.id = f.person_id ' +
    'WHERE f.photo_id = ? ORDER BY f.id ASC'
  ).all(photo.id);
  res.render('foto-gezichten', { photo, faces, persons: personsForSelect() });
});

// Persoon (of nieuwe naam) bepalen uit het formulier; geeft persoon-id terug.
function resolvePerson(req, res, { allowCreate } = { allowCreate: true }) {
  let personId = req.body.person_id ? Number(req.body.person_id) : null;
  const newName = (req.body.new_name || '').trim();
  if (personId) {
    if (newName) db.prepare('UPDATE persons SET name = ? WHERE id = ?').run(newName, personId);
    return personId;
  }
  if (allowCreate && (newName || req.body.create_unnamed)) {
    return Number(db.prepare('INSERT INTO persons (name, created_by) VALUES (?, ?)').run(newName, res.locals.user.id).lastInsertRowid);
  }
  return null;
}

// Gezicht toevoegen aan een foto (koppelt aan bestaande of nieuwe persoon).
app.post('/beheer/foto/:id/gezicht', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!photo) return res.status(404).send('Foto niet gevonden');
  const f = (v) => parseFloat(String(v).replace(',', '.'));
  const c01 = (v) => Math.max(0, Math.min(1, v));
  let x = f(req.body.x), y = f(req.body.y), w = f(req.body.w), h = f(req.body.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    req.session.flash = { type: 'err', msg: 'Kon het gezichtsvak niet lezen.' };
    return res.redirect('/beheer/foto/' + photo.id + '/gezichten');
  }
  x = c01(x); y = c01(y); w = c01(w); h = c01(h);
  const personId = resolvePerson(req, res, { allowCreate: true }) ||
    Number(db.prepare('INSERT INTO persons (name, created_by) VALUES (?, ?)').run('', res.locals.user.id).lastInsertRowid);
  db.prepare('INSERT INTO faces (photo_id, person_id, x, y, w, h, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(photo.id, personId, x, y, w, h, 'handmatig', res.locals.user.id);
  addLog(actor(res), 'gezicht getagd op foto #' + photo.id, 'content');
  res.redirect('/beheer/foto/' + photo.id + '/gezichten');
});

// Gezicht aan een andere persoon koppelen (of losmaken).
app.post('/beheer/gezicht/:id/persoon', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const face = db.prepare('SELECT * FROM faces WHERE id = ?').get(req.params.id);
  if (!face) return res.redirect('/namen');
  const personId = resolvePerson(req, res, { allowCreate: true });
  db.prepare('UPDATE faces SET person_id = ? WHERE id = ?').run(personId, face.id);
  res.redirect(req.body.back || ('/beheer/foto/' + face.photo_id + '/gezichten'));
});

// Gezicht verwijderen.
app.post('/beheer/gezicht/:id/verwijderen', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const face = db.prepare('SELECT * FROM faces WHERE id = ?').get(req.params.id);
  if (face) db.prepare('DELETE FROM faces WHERE id = ?').run(face.id);
  res.redirect(req.body.back || (face ? ('/beheer/foto/' + face.photo_id + '/gezichten') : '/namen'));
});

// Persoon hernoemen.
app.post('/beheer/persoon/:id', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const person = db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.id);
  if (!person) return res.redirect('/namen');
  const name = (req.body.name || '').trim();
  db.prepare('UPDATE persons SET name = ? WHERE id = ?').run(name, person.id);
  addLog(actor(res), 'persoon #' + person.id + (name ? ' benoemd als "' + name + '"' : ' naam gewist'), 'content');
  res.redirect('/persoon/' + person.id);
});

// Omslagfoto (representatief gezicht) van een persoon kiezen voor het Namenoverzicht.
app.post('/beheer/persoon/:id/omslag', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const person = db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.id);
  if (!person) return res.redirect('/namen');
  const faceId = Number(req.body.face_id) || null;
  if (faceId) {
    const ok = db.prepare('SELECT id FROM faces WHERE id = ? AND person_id = ?').get(faceId, person.id);
    if (!ok) return res.redirect('/persoon/' + person.id);
  }
  db.prepare('UPDATE persons SET cover_face_id = ? WHERE id = ?').run(faceId, person.id);
  res.redirect('/persoon/' + person.id);
});

// Twee personen samenvoegen (gezichten van 'from' gaan naar 'into').
app.post('/beheer/persoon/:id/samenvoegen', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const from = db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.id);
  const into = db.prepare('SELECT * FROM persons WHERE id = ?').get(Number(req.body.into));
  if (!from || !into || from.id === into.id) return res.redirect('/persoon/' + req.params.id);
  const tx = db.transaction(() => {
    db.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(into.id, from.id);
    if (!into.name && from.name) db.prepare('UPDATE persons SET name = ? WHERE id = ?').run(from.name, into.id);
    db.prepare('DELETE FROM persons WHERE id = ?').run(from.id);
  });
  tx();
  addLog(actor(res), 'persoon #' + from.id + ' samengevoegd met #' + into.id, 'content');
  res.redirect('/persoon/' + into.id);
});

// Persoon verwijderen (alleen admin); gezichten blijven bestaan maar worden losgekoppeld.
app.post('/beheer/persoon/:id/verwijderen', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const person = db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.id);
  if (person) {
    db.prepare('DELETE FROM persons WHERE id = ?').run(person.id); // faces.person_id -> NULL via FK
    addLog(actor(res), 'persoon #' + person.id + ' verwijderd', 'beheer');
  }
  res.redirect('/namen');
});

app.get('/jaar/:id', (req, res) => {
  const year = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!year) return res.redirect('/');
  year.photos = db.prepare('SELECT * FROM photos WHERE year_id = ? AND deleted = 0 ORDER BY sort ASC, id ASC').all(year.id);
  year.videos = db.prepare('SELECT * FROM videos WHERE year_id = ? ORDER BY sort ASC, id ASC').all(year.id);
  res.render('jaar', { year });
});

function extFromSrc(src) {
  const m = String(src || '').match(/\.([A-Za-z0-9]{1,5})(?:\?|#|$)/);
  return m ? m[1].toLowerCase() : 'jpg';
}
function safeName(s) { return String(s || '').replace(/[^A-Za-z0-9 ._-]+/g, '').trim(); }

/* Eén foto downloaden (ingelogd) */
app.get('/download/foto/:id', requireLogin, async (req, res) => {
  const p = db.prepare('SELECT * FROM photos WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!p) return res.status(404).send('Niet gevonden');
  const name = 'Mannenvakanties-' + safeName(yearLabel(p.year_id)) + '-' + p.id + '.' + extFromSrc(p.src);
  if (p.src.startsWith('/uploads/')) {
    return res.download(path.join(__dirname, 'data', p.src.replace('/uploads/', 'uploads/')), name);
  }
  try {
    const r = await fetch(p.src);
    if (!r.ok) return res.status(502).send('Kon de foto niet ophalen.');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).send('Kon de foto niet ophalen.'); }
});

/* Een heel jaar downloaden als zip (ingelogd) */
app.get('/download/jaar/:id', requireLogin, async (req, res) => {
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.status(404).send('Niet gevonden');
  const photos = db.prepare('SELECT * FROM photos WHERE year_id = ? AND deleted = 0 ORDER BY sort ASC, id ASC').all(y.id);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="Mannenvakanties-' + (safeName(y.year) || y.id) + '.zip"');
  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', () => { try { res.end(); } catch (e) {} });
  archive.pipe(res);
  let n = 1;
  for (const p of photos) {
    const cap = p.caption ? safeName(p.caption).slice(0, 40) + '-' : '';
    const name = String(n).padStart(3, '0') + '-' + cap + p.id + '.' + extFromSrc(p.src);
    if (p.src.startsWith('/uploads/')) {
      const fp = path.join(__dirname, 'data', p.src.replace('/uploads/', 'uploads/'));
      if (fs.existsSync(fp)) archive.file(fp, { name });
    } else {
      try { const r = await fetch(p.src); if (r.ok) archive.append(Buffer.from(await r.arrayBuffer()), { name }); } catch (e) { /* sla over */ }
    }
    n++;
  }
  archive.finalize();
});

/* ------------------------------------------------------------------ */
/*  Registreren / inloggen / uitloggen                                 */
/* ------------------------------------------------------------------ */
app.get('/aanmelden', (req, res) => res.render('register', { values: {}, error: null }));

app.post('/aanmelden', (req, res) => {
  if (!checkCsrf(req, res)) return;
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');
  const answer = normAnswer(req.body.answer);

  const fail = (error) => res.status(400).render('register', { values: { username }, error });

  if (answer !== JOIN_ANSWER) return fail('Dat is niet het juiste antwoord op de toegangsvraag. Vraag het anders even na bij de groep.');
  if (username.length < 3 || username.length > 40) return fail('Kies een gebruikersnaam van 3 tot 40 tekens.');
  if (!/^[\p{L}\p{N}._\- ]+$/u.test(username)) return fail('Gebruik alleen letters, cijfers, spatie, punt, streepje of underscore.');
  if (password.length < 8) return fail('Kies een wachtwoord van minstens 8 tekens.');
  if (password !== password2) return fail('De twee wachtwoorden zijn niet gelijk.');

  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (exists) return fail('Die gebruikersnaam is al bezet.');

  const hash = bcrypt.hashSync(password, 12);
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const role = (isFirst || isDesignatedAdmin(username)) ? 'admin' : 'member';
  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hash, role);

  req.session.userId = info.lastInsertRowid;
  addLog(username, 'is lid geworden' + (role === 'admin' ? ' (beheerder)' : ''), 'lid');
  req.session.flash = { type: 'ok', msg: 'Welkom, ' + username + '! Je bent nu lid.' };
  res.redirect('/beheer');
});

app.get('/inloggen', (req, res) => res.render('login', { values: {}, error: null }));

app.post('/inloggen', (req, res) => {
  if (!checkCsrf(req, res)) return;
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { values: { username }, error: 'Gebruikersnaam of wachtwoord klopt niet.' });
  }
  req.session.userId = user.id;
  req.session.flash = { type: 'ok', msg: 'Je bent ingelogd.' };
  res.redirect('/beheer');
});

app.post('/uitloggen', (req, res) => {
  if (!checkCsrf(req, res)) return;
  req.session.destroy(() => res.redirect('/'));
});

/* ------------------------------------------------------------------ */
/*  Beheer (alleen ingelogd)                                           */
/* ------------------------------------------------------------------ */

function requireAdmin(req, res, next) {
  if (!res.locals.user || res.locals.user.role !== 'admin') {
    req.session.flash = { type: 'err', msg: 'Alleen een beheerder kan dit.' };
    return res.redirect('/beheer');
  }
  next();
}

/* Overzicht: lijst van jaren (zonder de foto's zelf) */
app.get('/beheer', requireLogin, (req, res) => {
  const years = db.prepare(
    'SELECT y.*, ' +
    '(SELECT COUNT(*) FROM photos p WHERE p.year_id = y.id AND p.deleted = 0) AS photo_count ' +
    'FROM years y ORDER BY y.year ASC, y.id ASC'
  ).all();
  const trashCount = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE deleted = 1').get().n;
  res.render('beheer', { years, trashCount, untaggedFaces: untaggedFaceCount() });
});

/* Eén jaar: pas hier worden de foto's getoond */
app.get('/beheer/jaar/:id', requireLogin, (req, res) => {
  const year = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!year) { req.session.flash = { type: 'err', msg: 'Jaar niet gevonden.' }; return res.redirect('/beheer'); }
  year.photos = db.prepare('SELECT * FROM photos WHERE year_id = ? AND deleted = 0 ORDER BY sort ASC, id ASC').all(year.id);
  year.videos = db.prepare('SELECT * FROM videos WHERE year_id = ? ORDER BY sort ASC, id ASC').all(year.id);
  res.render('beheer-jaar', { year });
});

/* Coördinaten opzoeken bij een plaatsnaam (OpenStreetMap Nominatim) */
app.get('/beheer/geocode', requireLogin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ error: 'Vul eerst een plaats in.' });
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mannenvakanties-fotoalbum/1.0' } });
    if (!r.ok) return res.json({ error: 'De zoekdienst gaf een fout (' + r.status + '). Probeer het zo nog eens.' });
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return res.json({ error: 'Geen plaats gevonden. Probeer een vollediger naam, bijv. "Waimes, België".' });
    const hit = data[0];
    res.json({ lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), name: hit.display_name });
  } catch (e) {
    res.json({ error: 'Kon de zoekdienst niet bereiken. Probeer het later nog eens of vul de coördinaten handmatig in.' });
  }
});

/* jaar aanmaken */
app.post('/beheer/jaar', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const year = String(req.body.year || '').trim();
  const place = String(req.body.place || '').trim();
  const note = String(req.body.note || '').trim();
  if (!year) { req.session.flash = { type: 'err', msg: 'Vul een jaar of titel in.' }; return res.redirect('/beheer'); }
  const info = db.prepare('INSERT INTO years (year, place, note, lat, lng, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(year, place, note, num(req.body.lat), num(req.body.lng), req.session.userId);
  addLog(actor(res), 'jaar "' + year + '" aangemaakt');
  req.session.flash = { type: 'ok', msg: 'Jaar "' + year + '" aangemaakt. Voeg hieronder foto\'s toe.' };
  res.redirect('/beheer/jaar/' + info.lastInsertRowid);
});

/* jaar bijwerken (eigenaar/admin) */
app.post('/beheer/jaar/:id', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.redirect('/beheer');
  if (!canEdit(res.locals.user, y.created_by)) { req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen jaren bewerken.' }; return res.redirect('/beheer/jaar/' + y.id); }
  db.prepare('UPDATE years SET year = ?, place = ?, note = ?, lat = ?, lng = ? WHERE id = ?')
    .run(String(req.body.year || y.year).trim(), String(req.body.place || '').trim(), String(req.body.note || '').trim(), num(req.body.lat), num(req.body.lng), y.id);
  addLog(actor(res), 'jaar "' + y.year + '" bijgewerkt');
  req.session.flash = { type: 'ok', msg: 'Jaar bijgewerkt.' };
  res.redirect('/beheer/jaar/' + y.id);
});

/* jaar verwijderen (alleen admin) — dit verwijdert ook de foto's definitief */
app.post('/beheer/jaar/:id/verwijderen', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.redirect('/beheer');
  db.prepare('DELETE FROM videos WHERE year_id = ?').run(y.id);
  db.prepare('DELETE FROM years WHERE id = ?').run(y.id); // photos cascade
  fs.rmSync(path.join(UPLOAD_DIR, String(y.id)), { recursive: true, force: true });
  addLog(actor(res), 'jaar "' + y.year + '" verwijderd');
  req.session.flash = { type: 'ok', msg: 'Jaar verwijderd.' };
  res.redirect('/beheer');
});

/* foto's uploaden naar een jaar (elk lid) */
app.post('/beheer/jaar/:id/fotos', requireLogin, (req, res) => {
  upload.array('fotos', 200)(req, res, (err) => {
    if (!checkCsrf(req, res)) return;
    const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
    if (!y) return res.redirect('/beheer');
    const back = '/beheer/jaar/' + y.id;
    if (err) { req.session.flash = { type: 'err', msg: 'Uploaden mislukte: ' + err.message }; return res.redirect(back); }
    const files = req.files || [];
    if (!files.length) { req.session.flash = { type: 'err', msg: 'Geen geldige afbeeldingen gekozen (alleen jpg, png, gif, webp; max 15 MB per stuk).' }; return res.redirect(back); }

    const startSort = (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM photos WHERE year_id = ?').get(y.id).m) + 1;
    const ins = db.prepare('INSERT INTO photos (year_id, src, caption, uploaded_by, sort, rotation, base_rotation, oriented) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      files.forEach((f, i) => {
        const rot = orientationToRotation(exifOrientation(f.path));
        ins.run(y.id, '/uploads/' + y.id + '/' + f.filename, '', req.session.userId, startSort + i, rot, rot, 1);
      });
    });
    tx();
    addLog(actor(res), files.length + ' foto(\'s) toegevoegd aan ' + y.year);
    req.session.flash = { type: 'ok', msg: files.length + ' foto(\'s) toegevoegd aan ' + y.year + '.' };
    res.redirect(back);
  });
});

/* bijschrift van een foto bijwerken (uploader/admin) — ondersteunt opslaan zonder herladen */
app.post('/beheer/foto/:id', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const ajax = req.get('X-Requested-With') === 'fetch';
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return ajax ? res.status(404).json({ error: 'niet gevonden' }) : res.redirect('/beheer');
  if (!canEdit(res.locals.user, p.uploaded_by)) {
    if (ajax) return res.status(403).json({ error: 'geen rechten' });
    req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen foto\'s bewerken.' }; return res.redirect('/beheer/jaar/' + p.year_id);
  }
  db.prepare('UPDATE photos SET caption = ? WHERE id = ?').run(String(req.body.caption || '').trim(), p.id);
  if (ajax) return res.json({ ok: true });
  req.session.flash = { type: 'ok', msg: 'Bijschrift opgeslagen.' };
  res.redirect('/beheer/jaar/' + p.year_id);
});

/* foto ZACHT verwijderen (uploader/admin) — blijft herstelbaar in de prullenbak */
app.post('/beheer/foto/:id/verwijderen', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return res.redirect('/beheer');
  if (!canEdit(res.locals.user, p.uploaded_by)) { req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen foto\'s verwijderen.' }; return res.redirect('/beheer/jaar/' + p.year_id); }
  db.prepare("UPDATE photos SET deleted = 1, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?").run(req.session.userId, p.id);
  addLog(actor(res), 'foto verwijderd uit ' + yearLabel(p.year_id));
  req.session.flash = { type: 'ok', msg: 'Foto verwijderd. Een beheerder kan hem nog herstellen.' };
  res.redirect('/beheer/jaar/' + p.year_id);
});

/* Foto draaien (90° links of rechts, of rechtzetten) — toevoeger/admin, niet-destructief */
app.post('/beheer/foto/:id/draai', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!p) return res.redirect('/beheer');
  if (!canEdit(res.locals.user, p.uploaded_by)) { req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen foto\'s draaien.' }; return res.redirect('/beheer/jaar/' + p.year_id); }
  let rot;
  if (req.body.richting === 'recht') rot = p.base_rotation || 0;
  else { const delta = req.body.richting === 'links' ? -90 : 90; rot = ((((p.rotation || 0) + delta) % 360) + 360) % 360; }
  db.prepare('UPDATE photos SET rotation = ? WHERE id = ?').run(rot, p.id);
  res.redirect('/beheer/jaar/' + p.year_id + '#foto-' + p.id);
});

/* Volgorde van foto's binnen een jaar opslaan (slepen) */
app.post('/beheer/jaar/:id/volgorde', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.status(404).json({ error: 'niet gevonden' });
  const ids = String(req.body.order || '').split(',').map((s) => parseInt(s, 10)).filter(Boolean);
  const valid = new Set(db.prepare('SELECT id FROM photos WHERE year_id = ? AND deleted = 0').all(y.id).map((r) => r.id));
  const upd = db.prepare('UPDATE photos SET sort = ? WHERE id = ? AND year_id = ?');
  const tx = db.transaction(() => { let i = 0; for (const id of ids) { if (valid.has(id)) upd.run(i++, id, y.id); } });
  tx();
  res.json({ ok: true });
});

/* Bulkacties op geselecteerde foto's: draaien of verwijderen */
app.post('/beheer/jaar/:id/bulk', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.redirect('/beheer');
  const back = '/beheer/jaar/' + y.id;
  const action = req.body.action;
  const ids = String(req.body.ids || '').split(',').map((s) => parseInt(s, 10)).filter(Boolean);
  if (!ids.length || !['links', 'rechts', 'verwijderen'].includes(action)) { req.session.flash = { type: 'info', msg: 'Niets geselecteerd.' }; return res.redirect(back); }
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const p = db.prepare('SELECT * FROM photos WHERE id = ? AND year_id = ? AND deleted = 0').get(id, y.id);
      if (!p || !canEdit(res.locals.user, p.uploaded_by)) continue;
      if (action === 'verwijderen') {
        db.prepare("UPDATE photos SET deleted = 1, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?").run(req.session.userId, p.id);
      } else {
        const delta = action === 'links' ? -90 : 90;
        const rot = ((((p.rotation || 0) + delta) % 360) + 360) % 360;
        db.prepare('UPDATE photos SET rotation = ? WHERE id = ?').run(rot, p.id);
      }
      n++;
    }
  });
  tx();
  if (n) addLog(actor(res), n + (action === 'verwijderen' ? ' foto(\'s) verwijderd uit ' : ' foto(\'s) gedraaid in ') + y.year, 'content');
  req.session.flash = { type: 'ok', msg: n + ' foto(\'s) ' + (action === 'verwijderen' ? 'verwijderd (herstelbaar in de prullenbak)' : 'gedraaid') + '.' };
  res.redirect(back);
});

/* Dubbele foto's opruimen binnen een jaar (alleen admin) — zacht verwijderd, dus herstelbaar */
app.post('/beheer/jaar/:id/ontdubbel', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.redirect('/beheer');
  const back = '/beheer/jaar/' + y.id;
  const photos = db.prepare('SELECT * FROM photos WHERE year_id = ? AND deleted = 0 ORDER BY sort ASC, id ASC').all(y.id);
  const seen = new Set();
  const dupes = [];
  for (const p of photos) {
    const key = photoKey(p);
    if (seen.has(key)) dupes.push(p.id); else seen.add(key);
  }
  if (dupes.length) {
    const stmt = db.prepare("UPDATE photos SET deleted = 1, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?");
    const tx = db.transaction(() => { for (const id of dupes) stmt.run(req.session.userId, id); });
    tx();
    addLog(actor(res), dupes.length + ' dubbele foto(\'s) opgeruimd in ' + y.year, 'content');
    req.session.flash = { type: 'ok', msg: dupes.length + ' dubbele foto(\'s) naar de prullenbak verplaatst. Van elke blijft er één staan.' };
  } else {
    req.session.flash = { type: 'ok', msg: 'Geen dubbele foto\'s gevonden in dit jaar.' };
  }
  res.redirect(back);
});

/* foto aanwijzen (of weghalen) als groepsfoto van het jaar (elk lid) */
app.post('/beheer/foto/:id/groepsfoto', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!p) return res.redirect('/beheer');
  const y = db.prepare('SELECT group_photo_id FROM years WHERE id = ?').get(p.year_id);
  const newVal = (y && y.group_photo_id === p.id) ? null : p.id;
  db.prepare('UPDATE years SET group_photo_id = ? WHERE id = ?').run(newVal, p.year_id);
  addLog(actor(res), (newVal ? 'groepsfoto ingesteld voor ' : 'groepsfoto verwijderd voor ') + yearLabel(p.year_id));
  req.session.flash = { type: 'ok', msg: newVal ? 'Groepsfoto ingesteld voor dit jaar.' : 'Groepsfoto verwijderd.' };
  res.redirect('/beheer/jaar/' + p.year_id);
});

/* YouTube-video toevoegen aan een jaar (elk lid) */
app.post('/beheer/jaar/:id/video', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.redirect('/beheer');
  const back = '/beheer/jaar/' + y.id;
  const vid = youtubeId(req.body.url);
  if (!vid) { req.session.flash = { type: 'err', msg: 'Dat lijkt geen geldige YouTube-link. Plak de link uit de adresbalk of via de "Delen"-knop (youtube.com/watch?v=… of youtu.be/…).' }; return res.redirect(back); }
  const title = String(req.body.title || '').trim().slice(0, 160);
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM videos WHERE year_id = ?').get(y.id).m) + 1;
  db.prepare('INSERT INTO videos (year_id, youtube_id, title, added_by, sort) VALUES (?, ?, ?, ?, ?)').run(y.id, vid, title, req.session.userId, sort);
  addLog(actor(res), 'video toegevoegd aan ' + y.year, 'content');
  req.session.flash = { type: 'ok', msg: 'Video toegevoegd.' };
  res.redirect(back);
});

/* Video verwijderen (toevoeger/admin) */
app.post('/beheer/video/:id/verwijderen', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.redirect('/beheer');
  if (!canEdit(res.locals.user, v.added_by)) { req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen video\'s verwijderen.' }; return res.redirect('/beheer/jaar/' + v.year_id); }
  db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
  addLog(actor(res), 'video verwijderd uit ' + yearLabel(v.year_id), 'content');
  req.session.flash = { type: 'ok', msg: 'Video verwijderd.' };
  res.redirect('/beheer/jaar/' + v.year_id);
});

/* ----- Prullenbak (alleen admin): herstellen of definitief verwijderen ----- */
app.get('/beheer/prullenbak', requireLogin, requireAdmin, (req, res) => {
  const photos = db.prepare(
    'SELECT p.*, y.year AS year_label, u.username AS deleted_by_name ' +
    'FROM photos p ' +
    'LEFT JOIN years y ON y.id = p.year_id ' +
    'LEFT JOIN users u ON u.id = p.deleted_by ' +
    'WHERE p.deleted = 1 ORDER BY p.deleted_at DESC, p.id DESC'
  ).all();
  res.render('prullenbak', { photos });
});

app.post('/beheer/foto/:id/herstellen', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (p) db.prepare('UPDATE photos SET deleted = 0, deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(p.id);
  addLog(actor(res), 'foto hersteld');
  req.session.flash = { type: 'ok', msg: 'Foto hersteld.' };
  res.redirect('/beheer/prullenbak');
});

app.post('/beheer/foto/:id/definitief', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (p) {
    db.prepare('UPDATE years SET group_photo_id = NULL WHERE group_photo_id = ?').run(p.id);
    db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    if (p.src.startsWith('/uploads/')) fs.rmSync(path.join(__dirname, 'data', p.src.replace('/uploads/', 'uploads/')), { force: true });
  }
  addLog(actor(res), 'foto definitief verwijderd');
  req.session.flash = { type: 'ok', msg: 'Foto definitief verwijderd.' };
  res.redirect('/beheer/prullenbak');
});

/* Bulk in de prullenbak: meerdere herstellen of definitief verwijderen */
app.post('/beheer/prullenbak/bulk', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const action = req.body.action;
  const ids = String(req.body.ids || '').split(',').map((s) => parseInt(s, 10)).filter(Boolean);
  if (!ids.length || !['herstellen', 'definitief'].includes(action)) { req.session.flash = { type: 'info', msg: 'Niets geselecteerd.' }; return res.redirect('/beheer/prullenbak'); }
  const toRemove = [];
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const p = db.prepare('SELECT * FROM photos WHERE id = ? AND deleted = 1').get(id);
      if (!p) continue;
      if (action === 'herstellen') {
        db.prepare('UPDATE photos SET deleted = 0, deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(p.id);
      } else {
        db.prepare('UPDATE years SET group_photo_id = NULL WHERE group_photo_id = ?').run(p.id);
        db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
        if (p.src.startsWith('/uploads/')) toRemove.push(p.src);
      }
      n++;
    }
  });
  tx();
  for (const src of toRemove) { try { fs.rmSync(path.join(__dirname, 'data', src.replace('/uploads/', 'uploads/')), { force: true }); } catch (e) {} }
  if (n) addLog(actor(res), n + (action === 'herstellen' ? ' foto(\'s) hersteld' : ' foto(\'s) definitief verwijderd'), action === 'herstellen' ? 'content' : 'beheer');
  req.session.flash = { type: 'ok', msg: n + ' foto(\'s) ' + (action === 'herstellen' ? 'hersteld' : 'definitief verwijderd') + '.' };
  res.redirect('/beheer/prullenbak');
});

/* Hele prullenbak in één keer definitief legen */
app.post('/beheer/prullenbak/leegmaken', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const photos = db.prepare('SELECT * FROM photos WHERE deleted = 1').all();
  const tx = db.transaction(() => {
    for (const p of photos) {
      db.prepare('UPDATE years SET group_photo_id = NULL WHERE group_photo_id = ?').run(p.id);
      db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    }
  });
  tx();
  for (const p of photos) { if (p.src.startsWith('/uploads/')) { try { fs.rmSync(path.join(__dirname, 'data', p.src.replace('/uploads/', 'uploads/')), { force: true }); } catch (e) {} } }
  if (photos.length) addLog(actor(res), 'prullenbak geleegd (' + photos.length + ' foto(\'s))', 'beheer');
  req.session.flash = { type: 'ok', msg: photos.length + ' foto(\'s) definitief verwijderd. De prullenbak is leeg.' };
  res.redirect('/beheer/prullenbak');
});

/* ----- Leden (alleen admin): beheerders aanwijzen ----- */
app.get('/beheer/leden', requireLogin, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC, id ASC').all();
  res.render('leden', { users });
});

/* Logboek (alleen admin): wie deed wat, wanneer */
app.get('/beheer/logboek', requireLogin, requireAdmin, (req, res) => {
  const logs = db.prepare('SELECT created_at, username, event FROM logs ORDER BY id DESC LIMIT 300').all();
  res.render('logboek', { logs });
});

/* Bezoekcijfers (alleen admin): hoeveel weergaves, unieke bezoekers, drukste jaren */
app.get('/beheer/statistieken', requireLogin, requireAdmin, (req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const totals = {
    views:    one("SELECT COUNT(*) AS n FROM visits").n,
    visitors: one("SELECT COUNT(DISTINCT visitor) AS n FROM visits").n,
    today:    one("SELECT COUNT(*) AS n FROM visits WHERE date(created_at) = date('now')").n,
    week:     one("SELECT COUNT(*) AS n FROM visits WHERE created_at >= datetime('now','-7 days')").n,
    month:    one("SELECT COUNT(*) AS n FROM visits WHERE created_at >= datetime('now','-30 days')").n,
    members:  one("SELECT COUNT(*) AS n FROM visits WHERE username IS NOT NULL").n,
  };
  totals.guests = totals.views - totals.members;

  // Per dag, laatste 30 dagen (alleen dagen met bezoek; view vult gaten op).
  const perDay = db.prepare(
    "SELECT date(created_at) AS day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors " +
    "FROM visits WHERE created_at >= datetime('now','-29 days') " +
    "GROUP BY day ORDER BY day ASC"
  ).all();

  // Drukste jaren (op jaar-pagina's).
  const topYears = db.prepare(
    "SELECT y.id, y.year, y.place, COUNT(*) AS views, COUNT(DISTINCT v.visitor) AS visitors " +
    "FROM visits v JOIN years y ON y.id = v.year_id " +
    "GROUP BY v.year_id ORDER BY views DESC, y.year ASC LIMIT 20"
  ).all();

  // Drukste pagina's (vaste pagina's, geen jaar-detail).
  const topPages = db.prepare(
    "SELECT path, COUNT(*) AS views FROM visits WHERE year_id IS NULL " +
    "GROUP BY path ORDER BY views DESC LIMIT 12"
  ).all();

  res.render('statistieken', { totals, perDay, topYears, topPages });
});

app.post('/beheer/leden/:id/rol', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/beheer/leden');
  if (target.id === res.locals.user.id) { req.session.flash = { type: 'err', msg: 'Je kunt je eigen rol niet wijzigen (om uitsluiting te voorkomen).' }; return res.redirect('/beheer/leden'); }
  const newRole = target.role === 'admin' ? 'member' : 'admin';
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, target.id);
  addLog(actor(res), target.username + ' is nu ' + (newRole === 'admin' ? 'beheerder' : 'lid'), 'beheer');
  req.session.flash = { type: 'ok', msg: target.username + ' is nu ' + (newRole === 'admin' ? 'beheerder' : 'lid') + '.' };
  res.redirect('/beheer/leden');
});

/* lid verwijderen (alleen admin) — foto's en jaren van het lid blijven bewaard */
app.post('/beheer/leden/:id/verwijderen', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/beheer/leden');
  if (target.id === res.locals.user.id) {
    req.session.flash = { type: 'err', msg: 'Je kunt je eigen account niet verwijderen.' };
    return res.redirect('/beheer/leden');
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE years  SET created_by  = NULL WHERE created_by  = ?').run(target.id);
    db.prepare('UPDATE photos SET uploaded_by = NULL WHERE uploaded_by = ?').run(target.id);
    db.prepare('UPDATE photos SET deleted_by  = NULL WHERE deleted_by  = ?').run(target.id);
    db.prepare('UPDATE videos SET added_by    = NULL WHERE added_by    = ?').run(target.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  });
  tx();
  addLog(actor(res), 'lid "' + target.username + '" verwijderd', 'beheer');
  req.session.flash = { type: 'ok', msg: 'Lid "' + target.username + '" verwijderd. Geüploade foto\'s en jaren blijven bewaard.' };
  res.redirect('/beheer/leden');
});

/* ------------------------------------------------------------------ */
app.use((req, res) => res.status(404).render('login', { values: {}, error: 'Pagina niet gevonden.' }));

app.listen(PORT, () => console.log('Mannenvakanties draait op http://localhost:' + PORT));
