import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'cmon.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL UNIQUE,
    mtime       REAL NOT NULL,
    size        INTEGER NOT NULL,
    title       TEXT NOT NULL,
    artist      TEXT NOT NULL DEFAULT '',
    album       TEXT NOT NULL DEFAULT '',
    genre       TEXT NOT NULL DEFAULT '',
    year        INTEGER,
    track_no    INTEGER,
    disc_no     INTEGER,
    duration    REAL NOT NULL DEFAULT 0,
    rating      INTEGER NOT NULL DEFAULT 0,
    play_count  INTEGER NOT NULL DEFAULT 0,
    last_played INTEGER,
    checked     INTEGER NOT NULL DEFAULT 1,
    added_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pt_playlist ON playlist_tracks(playlist_id, position);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- settings ----

const DEFAULT_SETTINGS = { music_folder: '', volume: 0.8, shuffle: false, repeat: 'off' };

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    out[key] = JSON.parse(value);
  }
  return out;
}

export function setSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS) stmt.run(key, JSON.stringify(value));
    }
  });
  return getSettings();
}

// ---- tracks ----

const TRACK_COLUMNS = `id, title, artist, album, genre, year, track_no, disc_no, duration, size,
  rating, play_count, last_played, checked, added_at`;

export function allTracks() {
  return db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks`).all();
}

export function getTrack(id) {
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
}

export function updateTrack(id, { rating, checked }) {
  if (rating !== undefined) {
    db.prepare('UPDATE tracks SET rating = ? WHERE id = ?').run(Math.max(0, Math.min(5, rating | 0)), id);
  }
  if (checked !== undefined) {
    db.prepare('UPDATE tracks SET checked = ? WHERE id = ?').run(checked ? 1 : 0, id);
  }
  return db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`).get(id);
}

export function markPlayed(id) {
  db.prepare('UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?').run(Date.now(), id);
  return db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`).get(id);
}

// Built-in smart playlists, computed on demand.
const SMART = {
  'recently-played': `SELECT id FROM tracks WHERE last_played IS NOT NULL ORDER BY last_played DESC LIMIT 25`,
  'top-rated': `SELECT id FROM tracks WHERE rating >= 4 ORDER BY rating DESC, play_count DESC`,
  'most-played': `SELECT id FROM tracks WHERE play_count > 0 ORDER BY play_count DESC, last_played DESC LIMIT 25`,
  'recently-added': `SELECT id FROM tracks ORDER BY added_at DESC, id DESC LIMIT 100`,
};

export function smartPlaylistIds(kind) {
  const sql = SMART[kind];
  if (!sql) return null;
  return db.prepare(sql).all().map((r) => r.id);
}

// ---- playlists ----

export function listPlaylists() {
  return db.prepare(`
    SELECT p.id, p.name, COUNT(pt.track_id) AS count
    FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    GROUP BY p.id ORDER BY p.name COLLATE NOCASE
  `).all();
}

export function getPlaylist(id) {
  return db.prepare('SELECT id, name FROM playlists WHERE id = ?').get(id);
}

export function createPlaylist(name, trackIds = []) {
  const { lastInsertRowid } = db.prepare('INSERT INTO playlists (name, created_at) VALUES (?, ?)').run(name, Date.now());
  const id = Number(lastInsertRowid);
  if (trackIds.length) addToPlaylist(id, trackIds);
  return getPlaylist(id);
}

export function renamePlaylist(id, name) {
  db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, id);
  return getPlaylist(id);
}

export function deletePlaylist(id) {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
}

export function playlistTrackIds(id) {
  return db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(id).map((r) => r.track_id);
}

function writePlaylistOrder(id, trackIds) {
  const known = new Set(db.prepare('SELECT id FROM tracks').all().map((r) => r.id));
  const insert = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)');
  transaction(() => {
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
    let pos = 0;
    for (const trackId of trackIds) {
      if (known.has(trackId)) insert.run(id, trackId, pos++);
    }
  });
  return playlistTrackIds(id);
}

export function addToPlaylist(id, trackIds, index) {
  const current = playlistTrackIds(id);
  const at = index == null ? current.length : Math.max(0, Math.min(current.length, index));
  current.splice(at, 0, ...trackIds);
  return writePlaylistOrder(id, current);
}

export function reorderPlaylist(id, trackIds) {
  return writePlaylistOrder(id, trackIds);
}

export function removeFromPlaylist(id, positions) {
  const drop = new Set(positions);
  return writePlaylistOrder(id, playlistTrackIds(id).filter((_, i) => !drop.has(i)));
}
