'use strict';

/**
 * Eenvoudige sessie-opslag in dezelfde SQLite-database.
 * Werkt met zowel better-sqlite3 als node:sqlite (synchrone prepare/run/get).
 */

module.exports = function (session) {
  const Store = session.Store;

  class SqliteStore extends Store {
    constructor(db) {
      super();
      this.db = db;
      db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire TEXT NOT NULL)');
      this._get = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?');
      this._set = db.prepare('INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire');
      this._del = db.prepare('DELETE FROM sessions WHERE sid = ?');
      this._touch = db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
      this._clear = db.prepare('DELETE FROM sessions WHERE expire < ?');
      const t = setInterval(() => { try { this._clear.run(new Date().toISOString()); } catch (e) {} }, 15 * 60 * 1000);
      if (t.unref) t.unref();
    }

    _expireAt(sess) {
      const ms = (sess.cookie && sess.cookie.maxAge) ? sess.cookie.maxAge : 1000 * 60 * 60 * 24;
      return new Date(Date.now() + ms).toISOString();
    }

    get(sid, cb) {
      try {
        const row = this._get.get(sid);
        if (!row) return cb(null, null);
        if (row.expire < new Date().toISOString()) { this._del.run(sid); return cb(null, null); }
        cb(null, JSON.parse(row.sess));
      } catch (e) { cb(e); }
    }

    set(sid, sess, cb) {
      try { this._set.run(sid, JSON.stringify(sess), this._expireAt(sess)); if (cb) cb(null); }
      catch (e) { if (cb) cb(e); }
    }

    destroy(sid, cb) {
      try { this._del.run(sid); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
    }

    touch(sid, sess, cb) {
      try { this._touch.run(this._expireAt(sess), sid); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
    }
  }

  return SqliteStore;
};
