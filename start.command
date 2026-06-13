#!/bin/bash
# Dubbelklik dit bestand om Mannenvakanties lokaal te starten (macOS).
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is niet gevonden."
  echo "Installeer eerst Node.js 22 LTS via https://nodejs.org en dubbelklik dit bestand opnieuw."
  read -p "Druk op Enter om te sluiten..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Pakketten installeren (dit gebeurt alleen de eerste keer)..."
  npm install || { echo "Installeren mislukte."; read -p "Druk op Enter om te sluiten..."; exit 1; }
fi

# open de browser zodra de server waarschijnlijk klaar is
( sleep 4; open http://localhost:3000 >/dev/null 2>&1 ) &

echo ""
echo "Mannenvakanties draait op http://localhost:3000"
echo "Sluit dit venster of druk Ctrl+C om te stoppen."
echo ""
npm start
