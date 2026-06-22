# Deployen naar je eigen server

Dit is het stappenplan om Mannenvakanties op een Linux-server (bv. Ubuntu/Debian
VPS) live te zetten achter https. Je voert dit zelf uit; ik kan niet op je server
inloggen. Reken op 15–20 minuten.

> Ga ervan uit dat je SSH-toegang hebt en software mag installeren (sudo). Draait
> je server iets anders (gedeelde hosting, Plesk/cPanel, Docker, Windows), zeg dat
> dan even — dan pas ik dit aan.

Vervang overal `album.jouwdomein.de` door je eigen (sub)domein, en laat dat domein
in je DNS naar het IP-adres van de server wijzen.

---

## 1. Node.js installeren (eenmalig)

```bash
# Node.js 22 LTS op Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3
node -v   # moet v22.x tonen
```

`build-essential` en `python3` zijn nodig om de snelle database (better-sqlite3)
te compileren. Lukt dat niet, dan gebruikt de app automatisch de ingebouwde SQLite
van Node 22 — het werkt dan nog steeds.

## 2. Bestanden plaatsen

```bash
sudo mkdir -p /var/www/mannenvakanties
# kopieer de inhoud van de map mannenvakanties-app hierheen
# (bv. met scp vanaf je eigen computer, of git clone)
cd /var/www/mannenvakanties
npm install --omit=dev
```

## 3. Een eigen gebruiker (aanbevolen)

```bash
sudo useradd -r -s /usr/sbin/nologin mannen
sudo chown -R mannen:mannen /var/www/mannenvakanties
```

## 4. Als service draaien (blijft draaien, herstart automatisch)

```bash
sudo cp deploy/mannenvakanties.service /etc/systemd/system/
sudo nano /etc/systemd/system/mannenvakanties.service   # vul de << >> velden in
sudo systemctl daemon-reload
sudo systemctl enable --now mannenvakanties
sudo systemctl status mannenvakanties                   # moet "active (running)" zijn
```

Tip voor `SESSION_SECRET`: genereer er een met `openssl rand -hex 32`.

De app luistert nu intern op `http://127.0.0.1:3000`. Nog niet van buitenaf bereikbaar — dat doet nginx hierna.

## 5. nginx als reverse proxy + https

```bash
sudo apt-get install -y nginx
sudo cp deploy/nginx-mannenvakanties.conf /etc/nginx/sites-available/mannenvakanties
sudo nano /etc/nginx/sites-available/mannenvakanties     # zet je domein erin
sudo ln -s /etc/nginx/sites-available/mannenvakanties /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Daarna een gratis https-certificaat:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d album.jouwdomein.de
```

Certbot past het nginx-bestand automatisch aan voor https en zet een
automatische verlenging op. Klaar — open nu `https://album.jouwdomein.de`.

## 6. Firewall (als die aanstaat)

```bash
sudo ufw allow 'Nginx Full'
sudo ufw allow OpenSSH
```

---

## Eerste gebruik

De **eerste** persoon die zich aanmeldt wordt automatisch beheerder. Doe dat dus
zelf meteen, vóór je de link deelt.

## Bijwerken naar een nieuwe versie

De service draait sinds kort vóór elke start zelf `npm install` (zie de regel
`ExecStartPre=` in het service-bestand). Bijwerken is dus simpelweg de nieuwe
code ophalen en herstarten — dependencies komen automatisch mee:

```bash
cd /var/www/mannenvakanties
git pull                                  # of je auto-pull doet dit
sudo systemctl restart mannenvakanties    # ExecStartPre draait dan npm install
```

> Draai je een **bestaande** server bij die deze automatische install nog niet
> had? Werk het service-bestand eenmalig bij, en doe de eerste (zware) install
> met de hand zodat de timeout niet in de weg zit:
>
> ```bash
> cd /var/www/mannenvakanties
> npm install --omit=dev                  # eenmalig; haalt o.a. de ~285 MB detectiebibliotheken
> sudo cp deploy/mannenvakanties.service /etc/systemd/system/
> sudo nano /etc/systemd/system/mannenvakanties.service   # << >> velden opnieuw invullen
> sudo systemctl daemon-reload
> sudo systemctl restart mannenvakanties
> ```
>
> Zorg dat `node_modules/` van de service-gebruiker is (`sudo chown -R mannen:mannen /var/www/mannenvakanties`), anders kan de automatische install niets wegschrijven.

## Back-ups

Alle gegevens staan in `/var/www/mannenvakanties/data/` (database + geüploade
foto's). Een back-up is simpelweg die map kopiëren:

```bash
sudo tar czf mannenvakanties-backup-$(date +%F).tar.gz -C /var/www/mannenvakanties data
```

## Problemen oplossen

```bash
sudo journalctl -u mannenvakanties -e      # logs van de app
sudo systemctl status mannenvakanties
```

- **Inloggen lukt niet achter https**: controleer dat `NODE_ENV=production` in de
  service staat (de app vertrouwt dan de proxy en stuurt veilige cookies).
- **Upload van grote foto's faalt**: verhoog `client_max_body_size` in het
  nginx-bestand en herlaad nginx.
