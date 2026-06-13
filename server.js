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
function allYearsWithPhotos() {
  const years = db.prepare('SELECT * FROM years ORDER BY year ASC, id ASC').all();
  const getPhotos = db.prepare('SELECT * FROM photos WHERE year_id = ? ORDER BY sort ASC, id ASC');
  for (const y of years) y.photos = getPhotos.all(y.id);
  return years;
}

/* ------------------------------------------------------------------ */
/*  Publieke galerij                                                   */
/* ------------------------------------------------------------------ */
app.get('/', (req, res) => {
  res.render('gallery', { years: allYearsWithPhotos() });
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

  const fail = (error) => res.status(400).render('register', { values: { username }, error });

  if (username.length < 3 || username.length > 40) return fail('Kies een gebruikersnaam van 3 tot 40 tekens.');
  if (!/^[\p{L}\p{N}._\- ]+$/u.test(username)) return fail('Gebruik alleen letters, cijfers, spatie, punt, streepje of underscore.');
  if (password.length < 8) return fail('Kies een wachtwoord van minstens 8 tekens.');
  if (password !== password2) return fail('De twee wachtwoorden zijn niet gelijk.');

  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (exists) return fail('Die gebruikersnaam is al bezet.');

  const hash = bcrypt.hashSync(password, 12);
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hash, isFirst ? 'admin' : 'member');

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
app.get('/beheer', requireLogin, (req, res) => {
  res.render('beheer', { years: allYearsWithPhotos() });
});

/* jaar aanmaken */
app.post('/beheer/jaar', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const year = String(req.body.year || '').trim();
  const place = String(req.body.place || '').trim();
  const note = String(req.body.note || '').trim();
  if (!year) { req.session.flash = { type: 'err', msg: 'Vul een jaar of titel in.' }; return res.redirect('/beheer'); }
  db.prepare('INSERT INTO years (year, place, note, created_by) VALUES (?, ?, ?, ?)')
    .run(year, place, note, req.session.userId);
  req.session.flash = { type: 'ok', msg: 'Jaar "' + year + '" aangemaakt.' };
  res.redirect('/beheer');
});

/* jaar bijwerken (eigenaar/admin) */
app.post('/beheer/jaar/:id', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.redirect('/beheer');
  if (!canEdit(res.locals.user, y.created_by)) { req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen jaren bewerken.' }; return res.redirect('/beheer'); }
  db.prepare('UPDATE years SET year = ?, place = ?, note = ? WHERE id = ?')
    .run(String(req.body.year || y.year).trim(), String(req.body.place || '').trim(), String(req.body.note || '').trim(), y.id);
  req.session.flash = { type: 'ok', msg: 'Jaar bijgewerkt.' };
  res.redirect('/beheer');
});

/* jaar verwijderen (eigenaar/admin) — verwijdert ook de geüploade bestanden */
app.post('/beheer/jaar/:id/verwijderen', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const y = db.prepare('SELECT * FROM years WHERE id = ?').get(req.params.id);
  if (!y) return res.redirect('/beheer');
  if (!canEdit(res.locals.user, y.created_by)) { req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen jaren verwijderen.' }; return res.redirect('/beheer'); }
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
    if (err) { req.session.flash = { type: 'err', msg: 'Uploaden mislukte: ' + err.message }; return res.redirect('/beheer'); }
    const files = req.files || [];
    if (!files.length) { req.session.flash = { type: 'err', msg: 'Geen geldige afbeeldingen gekozen (alleen jpg, png, gif, webp; max 15 MB per stuk).' }; return res.redirect('/beheer'); }

    const startSort = (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM photos WHERE year_id = ?').get(y.id).m) + 1;
    const ins = db.prepare('INSERT INTO photos (year_id, src, caption, uploaded_by, sort) VALUES (?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      files.forEach((f, i) => ins.run(y.id, '/uploads/' + y.id + '/' + f.filename, '', req.session.userId, startSort + i));
    });
    tx();
    req.session.flash = { type: 'ok', msg: files.length + ' foto(\'s) toegevoegd aan ' + y.year + '.' };
    res.redirect('/beheer');
  });
});

/* bijschrift van een foto bijwerken (uploader/admin) */
app.post('/beheer/foto/:id', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return res.redirect('/beheer');
  if (!canEdit(res.locals.user, p.uploaded_by)) { req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen foto\'s bewerken.' }; return res.redirect('/beheer'); }
  db.prepare('UPDATE photos SET caption = ? WHERE id = ?').run(String(req.body.caption || '').trim(), p.id);
  req.session.flash = { type: 'ok', msg: 'Bijschrift opgeslagen.' };
  res.redirect('/beheer');
});

/* foto verwijderen (uploader/admin) */
app.post('/beheer/foto/:id/verwijderen', requireLogin, (req, res) => {
  if (!checkCsrf(req, res)) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return res.redirect('/beheer');
  if (!canEdit(res.locals.user, p.uploaded_by)) { req.session.flash = { type: 'err', msg: 'Je mag alleen je eigen foto\'s verwijderen.' }; return res.redirect('/beheer'); }
  db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
  if (p.src.startsWith('/uploads/')) fs.rmSync(path.join(__dirname, 'data', p.src.replace('/uploads/', 'uploads/')), { force: true });
  req.session.flash = { type: 'ok', msg: 'Foto verwijderd.' };
  res.redirect('/beheer');
});

/* ------------------------------------------------------------------ */
app.use((req, res) => res.status(404).render('login', { values: {}, error: 'Pagina niet gevonden.' }));

app.listen(PORT, () => console.log('Mannenvakanties draait op http://localhost:' + PORT));
