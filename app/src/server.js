import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';
import { scanLibrary, scanState, resolveMediaPath, MEDIA_ROOT, AUDIO_TYPES } from './scanner.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

const api = express.Router();
app.use('/api', api);

const id = (req) => Number(req.params.id);
const idList = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);

// ---- status & settings ----

api.get('/status', (req, res) => {
  const { n } = store.db.prepare('SELECT COUNT(*) AS n FROM tracks').get();
  res.json({ scan: scanState, trackCount: n });
});

api.get('/settings', (req, res) => res.json(store.getSettings()));

api.put('/settings', (req, res) => {
  const before = store.getSettings();
  const patch = { ...req.body };
  if ('music_folder' in patch) {
    const rel = '/' + String(patch.music_folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!resolveMediaPath(rel)) return res.status(400).json({ error: 'Invalid folder' });
    patch.music_folder = rel;
  }
  const after = store.setSettings(patch);
  if (after.music_folder !== before.music_folder) scanLibrary();
  res.json(after);
});

api.post('/rescan', (req, res) => {
  scanLibrary();
  res.json({ ok: true });
});

// List subfolders of the Umbrel home storage for the folder picker.
api.get('/browse', async (req, res) => {
  const rel = '/' + String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const abs = resolveMediaPath(rel);
  if (!abs) return res.status(400).json({ error: 'Invalid folder' });
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const dirs = entries
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    res.json({ path: rel === '/' ? '/' : rel, root: MEDIA_ROOT, dirs });
  } catch {
    res.status(404).json({ error: 'Folder not found' });
  }
});

// ---- tracks ----

api.get('/tracks', (req, res) => res.json(store.allTracks()));

// Bulk edit, e.g. Ctrl-clicking a checkbox to check/uncheck every song in the list.
api.patch('/tracks', (req, res) => {
  const ids = idList(req.body.ids);
  store.transaction(() => ids.forEach((tid) => store.updateTrack(tid, req.body)));
  res.json({ updated: ids.length });
});

api.patch('/tracks/:id', (req, res) => {
  const track = store.updateTrack(id(req), req.body);
  track ? res.json(track) : res.sendStatus(404);
});

api.post('/tracks/:id/played', (req, res) => {
  const track = store.markPlayed(id(req));
  track ? res.json(track) : res.sendStatus(404);
});

api.get('/tracks/:id/stream', (req, res) => {
  const track = store.getTrack(id(req));
  if (!track) return res.sendStatus(404);
  const type = AUDIO_TYPES[path.extname(track.path).toLowerCase()] || 'application/octet-stream';
  res.sendFile(track.path, { headers: { 'Content-Type': type }, dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

api.get('/smart/:kind', (req, res) => {
  const ids = store.smartPlaylistIds(req.params.kind);
  ids ? res.json(ids) : res.sendStatus(404);
});

// ---- playlists ----

api.get('/playlists', (req, res) => res.json(store.listPlaylists()));

api.post('/playlists', (req, res) => {
  const name = String(req.body.name || 'untitled playlist').trim() || 'untitled playlist';
  res.status(201).json(store.createPlaylist(name, idList(req.body.trackIds)));
});

api.patch('/playlists/:id', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const pl = store.renamePlaylist(id(req), name);
  pl ? res.json(pl) : res.sendStatus(404);
});

api.delete('/playlists/:id', (req, res) => {
  store.deletePlaylist(id(req));
  res.sendStatus(204);
});

api.get('/playlists/:id/tracks', (req, res) => {
  if (!store.getPlaylist(id(req))) return res.sendStatus(404);
  res.json(store.playlistTrackIds(id(req)));
});

api.post('/playlists/:id/tracks', (req, res) => {
  if (!store.getPlaylist(id(req))) return res.sendStatus(404);
  const index = Number.isInteger(req.body.index) ? req.body.index : undefined;
  res.json(store.addToPlaylist(id(req), idList(req.body.trackIds), index));
});

api.put('/playlists/:id/tracks', (req, res) => {
  if (!store.getPlaylist(id(req))) return res.sendStatus(404);
  res.json(store.reorderPlaylist(id(req), idList(req.body.trackIds)));
});

api.delete('/playlists/:id/tracks', (req, res) => {
  if (!store.getPlaylist(id(req))) return res.sendStatus(404);
  res.json(store.removeFromPlaylist(id(req), idList(req.body.positions)));
});

app.listen(PORT, () => {
  console.log(`CmonMusicPlayer listening on :${PORT} (media root ${MEDIA_ROOT})`);
  // Every launch picks up music added since last time.
  scanLibrary();
});
