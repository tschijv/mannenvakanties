'use strict';

/**
 * Databasestuurprogramma met automatische keuze:
 *   1. better-sqlite3  — snel, native, werkt op Node 18+ (vereist build-tools bij installatie)
 *   2. node:sqlite     — ingebouwd in Node 22.5+, geen compilatie nodig (terugvaloptie)
 *
 * Beide leveren dezelfde methodes: prepare(), exec(), pragma(), transaction().
 */

function createDb(file) {
  try {
    const Database = require('better-sqlite3');
    const raw = new Database(file);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    console.log('Database: better-sqlite3');
    return raw; // native API voldoet al
  } catch (e) {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');
    console.log('Database: node:sqlite (ingebouwd)');
    return wrap(raw);
  }
}

function wrap(raw) {
  return {
    driver: 'node:sqlite',
    raw,
    exec: (sql) => raw.exec(sql),
    pragma: (str) => raw.exec('PRAGMA ' + str),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...a) => stmt.run(...a),
        get: (...a) => stmt.get(...a),
        all: (...a) => stmt.all(...a)
      };
    },
    transaction: (fn) => (...args) => {
      raw.exec('BEGIN');
      try { const r = fn(...args); raw.exec('COMMIT'); return r; }
      catch (err) { raw.exec('ROLLBACK'); throw err; }
    }
  };
}

module.exports = { createDb };
