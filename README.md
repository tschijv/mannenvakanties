# Mannenvakanties — gedeeld reisalbum

Een kleine webapplicatie waarin bezoekers **lid kunnen worden** en ingelogde leden
zelf **jaren aanmaken, foto's uploaden en bijschriften/teksten toevoegen**. De
publieke kant is het warme, nostalgische fotoalbum; de beheerkant is afgeschermd
met registratie en login.

De database start gevuld met de drie bestaande jaren (1997 Spa, 2003 Verdun,
2009 Waimes). Die foto's worden nog rechtstreeks vanaf de oude xs4all-site geladen
(zie *Foto's* onderaan). Nieuw geüploade foto's komen op je eigen server te staan.

## Vereisten

- **Node.js 18 of hoger.**
- De app gebruikt bij voorkeur `better-sqlite3` (snel, native). Dat pakket wordt
  bij installatie gecompileerd; daarvoor zijn standaard build-tools nodig
  (op Debian/Ubuntu: `sudo apt install build-essential python3`).
- Lukt compileren niet, dan valt de app **automatisch** terug op de SQLite die
  in **Node 22.5+** is ingebouwd — dan is er niets te compileren.

## Installeren en starten

```bash
npm install
npm start
# open http://localhost:3000
```

De **eerste** gebruiker die zich aanmeldt wordt automatisch **beheerder**
(mag alles bewerken/verwijderen). Daarna is iedere nieuwe aanmelding een gewoon lid
(mag eigen bijdragen bewerken/verwijderen).

## Instellingen (omgevingsvariabelen)

| Variabele        | Standaard      | Toelichting |
|------------------|----------------|-------------|
| `PORT`           | `3000`         | Poort waarop de app luistert |
| `SESSION_SECRET` | willekeurig    | **Zet een vaste, geheime waarde in productie**, anders worden sessies ongeldig bij herstart |
| `NODE_ENV`       | —              | Zet op `production` als de site **achter https** draait; cookies worden dan `secure` |

Voorbeeld voor productie:

```bash
NODE_ENV=production PORT=3000 SESSION_SECRET="een-lange-willekeurige-string" node server.js
```

## Op je eigen server plaatsen

1. Zet de map op de server en draai `npm install`.
2. Houd het proces draaiend met bijvoorbeeld **pm2** (`pm2 start server.js --name mannenvakanties`) of een **systemd**-service.
3. Zet er een reverse proxy (nginx/Apache) vóór die https afhandelt en doorstuurt naar `localhost:3000`. Zet dan `NODE_ENV=production`.

## Waar staat de data?

Alles staat in de map **`data/`** (wordt automatisch aangemaakt):

- `data/app.db` — de database (gebruikers, jaren, foto's, sessies)
- `data/uploads/<jaar-id>/…` — de geüploade foto's

> Maak regelmatig een back-up van de hele `data/`-map. Die map staat bewust niet in versiebeheer (`.gitignore`).

## Foto's

- De **drie bestaande jaren** verwijzen naar de foto's op
  `https://tschijv.home.xs4all.nl/…`. Zolang die site online staat, werken ze.
  Verdwijnt die ooit, dan vallen alleen die seed-foto's weg (een ontbrekende foto
  toont netjes een lege plek in plaats van een kapot icoon).
- **Geüploade** foto's staan altijd lokaal in `data/uploads/` en blijven dus
  onafhankelijk bestaan.
- Wil je de oude xs4all-foto's permanent meeverhuizen, download ze dan eenmalig en
  vervang in de database de externe URL's door lokale uploads.

## Beveiliging en aandachtspunten

Ingebouwd: wachtwoorden gehasht met **bcrypt**, **CSRF**-token op alle formulieren,
`httpOnly`/`sameSite=lax` sessiecookies, en upload-controle op type en grootte
(alleen afbeeldingen, max 15 MB per foto, max 40 per keer).

Omdat **iedereen** zich mag aanmelden, zijn dit verstandige vervolgstappen voordat
je breed publiceert:

- **Moderatie**: een beheerder die ongewenste bijdragen kan verwijderen (de
  admin-rol kan dat al). Eventueel nieuwe leden eerst laten goedkeuren.
- **Spam beperken**: rate limiting op aanmelden/inloggen en/of e-mailverificatie.
- Draai altijd **achter https** met `NODE_ENV=production`.

## Mappenstructuur

```
mannenvakanties-app/
├─ server.js                 # routes, auth, uploads
├─ database.js               # kiest better-sqlite3 of node:sqlite
├─ db.js                     # schema + seed (drie bestaande jaren)
├─ sqlite-session-store.js   # sessie-opslag in dezelfde database
├─ package.json
├─ public/
│  ├─ styles.css             # de warme albumstijl + formulieren
│  └─ gallery.js             # lightbox, scroll-animaties, jaarbalk
└─ views/                    # EJS-pagina's (galerij, inloggen, aanmelden, beheer)
```
