#!/bin/bash
# Start Mannenvakanties lokaal (Linux). Uitvoeren met:  ./start.sh
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is niet gevonden. Installeer Node.js 22 LTS via https://nodejs.org"
  read -p "Druk op Enter om te sluiten..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Pakketten installeren (dit gebeurt alleen de eerste keer)..."
  npm install || { echo "Installeren mislukte."; read -p "Druk op Enter om te sluiten..."; exit 1; }
fi

( sleep 4; xdg-open http://localhost:3000 >/dev/null 2>&1 ) &

echo ""
echo "Mannenvakanties draait op http://localhost:3000"
echo "Druk Ctrl+C om te stoppen."
echo ""
npm start
