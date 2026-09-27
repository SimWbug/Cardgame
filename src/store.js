/* Persistance simple en fichiers JSON (suffisant pour un jeu perso / entre amis).
   Node est mono-thread : ces écritures synchrones s'enchaînent sans corruption. */
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');

function filePath(name) { return path.join(DATA_DIR, name); }

function readJSON(name, fallback) {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJSON(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), 'utf-8');
}

module.exports = { readJSON, writeJSON };
