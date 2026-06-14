'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('./sqlite-session-store')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');

const { db, UPLOAD_DIR } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Vaste beheerders: namen uit ADMIN_USERS (komma-gescheiden) zijn altijd admin.
// Bijvoorbeeld in de systemd-service: Environment=ADMIN_USERS=Toine,Anton
const ADMIN_USERS = (process.env.ADMIN_USERS || 'Toine,Anton')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
function isDesignatedAdmin(username) {
  return ADMIN_USERS.includes(String(username || '').trim().toLowerCase());
}

// Toegangsvraag bij het aanmelden: alleen wie het antwoord weet, mag lid worden.
const JOIN_ANSWER = (process.env.JOIN_ANSWER || 'Utrecht').trim().toLowerCase();
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
  limits: { fileSize: 15 * 1024 * 1024, files: 40 },
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

app.get('/jaar/:id', (req, res) => {
  const year = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!year) return res.redirect('/');
  year.photos = db.prepare('SELECT * FROM photos WHERE year_id = ? AND deleted = 0 ORDER BY sort ASC, id ASC').all(year.id);
  res.render('jaar', { year });
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
  const answer = String(req.body.answer || '').trim().toLowerCase();

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
  res.render('beheer', { years, trashCount });
});

/* Eén jaar: pas hier worden de foto's getoond */
app.get('/beheer/jaar/:id', requireLogin, (req, res) => {
  const year = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!year) { req.session.flash = { type: 'err', msg: 'Jaar niet gevonden.' }; return res.redirect('/beheer'); }
  year.photos = db.prepare('SELECT * FROM photos WHERE year_id = ? AND deleted = 0 ORDER BY sort ASC, id ASC').all(year.id);
  res.render('beheer-jaar', { year });
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
  req.session.flash = { type: 'ok', msg: 'Jaar bijgewerkt.' };
  res.redirect('/beheer/jaar/' + y.id);
});

/* jaar verwijderen (alleen admin) — dit verwijdert ook de foto's definitief */
app.post('/beheer/jaar/:id/verwijderen', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.redirect('/beheer');
  db.prepare('DELETE FROM years WHERE id = ?').run(y.id); // photos cascade
  fs.rmSync(path.join(UPLOAD_DIR, String(y.id)), { recursive: true, force: true });
  req.session.flash = { type: 'ok', msg: 'Jaar verwijderd.' };
  res.redirect('/beheer');
});

/* foto's uploaden naar een jaar (elk lid) */
app.post('/beheer/jaar/:id/fotos', requireLogin, (req, res) => {
  upload.array('fotos', 40)(req, res, (err) => {
    if (!checkCsrf(req, res)) return;
    const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
    if (!y) return res.redirect('/beheer');
    const back = '/beheer/jaar/' + y.id;
    if (err) { req.session.flash = { type: 'err', msg: 'Uploaden mislukte: ' + err.message }; return res.redirect(back); }
    const files = req.files || [];
    if (!files.length) { req.session.flash = { type: 'err', msg: 'Geen geldige afbeeldingen gekozen (alleen jpg, png, gif, webp; max 15 MB per stuk).' }; return res.redirect(back); }

    const startSort = (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM photos WHERE year_id = ?').get(y.id).m) + 1;
    const ins = db.prepare('INSERT INTO photos (year_id, src, caption, uploaded_by, sort) VALUES (?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      files.forEach((f, i) => ins.run(y.id, '/uploads/' + y.id + '/' + f.filename, '', req.session.userId, startSort + i));
    });
    tx();
    req.session.flash = { type: 'ok', msg: files.length + ' foto(\'s) toegevoegd aan ' + y.year + '.' };
    res.redirect(back);
  });
});

/* bijschrift van een foto bijwerken (uploader/admin) */
app.post('/beheer/foto/:id', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return res.redirect('/beheer');
  if (!canEdit(res.locals.user, p.uploaded_by)) { req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen foto\'s bewerken.' }; return res.redirect('/beheer/jaar/' + p.year_id); }
  db.prepare('UPDATE photos SET caption = ? WHERE id = ?').run(String(req.body.caption || '').trim(), p.id);
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
  req.session.flash = { type: 'ok', msg: 'Foto verwijderd. Een beheerder kan hem nog herstellen.' };
  res.redirect('/beheer/jaar/' + p.year_id);
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
  req.session.flash = { type: 'ok', msg: 'Foto hersteld.' };
  res.redirect('/beheer/prullenbak');
});

app.post('/beheer/foto/:id/definitief', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (p) {
    db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    if (p.src.startsWith('/uploads/')) fs.rmSync(path.join(__dirname, 'data', p.src.replace('/uploads/', 'uploads/')), { force: true });
  }
  req.session.flash = { type: 'ok', msg: 'Foto definitief verwijderd.' };
  res.redirect('/beheer/prullenbak');
});

/* ----- Leden (alleen admin): beheerders aanwijzen ----- */
app.get('/beheer/leden', requireLogin, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC, id ASC').all();
  res.render('leden', { users });
});

app.post('/beheer/leden/:id/rol', requireLogin, requireAdmin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/beheer/leden');
  if (target.id === res.locals.user.id) { req.session.flash = { type: 'err', msg: 'Je kunt je eigen rol niet wijzigen (om uitsluiting te voorkomen).' }; return res.redirect('/beheer/leden'); }
  const newRole = target.role === 'admin' ? 'member' : 'admin';
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, target.id);
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
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  });
  tx();
  req.session.flash = { type: 'ok', msg: 'Lid "' + target.username + '" verwijderd. Geüploade foto\'s en jaren blijven bewaard.' };
  res.redirect('/beheer/leden');
});

/* ------------------------------------------------------------------ */
app.use((req, res) => res.status(404).render('login', { values: {}, error: 'Pagina niet gevonden.' }));

app.listen(PORT, () => console.log('Mannenvakanties draait op http://localhost:' + PORT));
