import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db, transaction, getSettings } from './db.js';

export const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/umbrel-home');

export const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
};

// Resolve a path relative to MEDIA_ROOT, refusing anything that escapes it.
export function resolveMediaPath(rel = '') {
  const abs = path.resolve(MEDIA_ROOT, '.' + path.posix.sep + String(rel).replace(/\\/g, '/'));
  if (abs !== MEDIA_ROOT && !abs.startsWith(MEDIA_ROOT + path.sep)) return null;
  return abs;
}

export const scanState = {
  scanning: false,
  done: 0,
  total: 0,
  added: 0,
  updated: 0,
  removed: 0,
  lastScan: null,
  error: null,
};

let rescanRequested = false;

async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = await fs.stat(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) await walk(full, out);
    else if (isFile && AUDIO_TYPES[path.extname(entry.name).toLowerCase()]) out.push(full);
  }
  return out;
}

function fallbackTags(file, root) {
  const base = path.basename(file, path.extname(file));
  const rel = path.relative(root, file).split(path.sep);
  const title = base.replace(/^\d{1,3}[\s.\-_]+/, '').trim() || base;
  return {
    title,
    album: rel.length >= 2 ? rel[rel.length - 2] : '',
    artist: rel.length >= 3 ? rel[rel.length - 3] : '',
  };
}

async function readTags(file, root) {
  const fb = fallbackTags(file, root);
  try {
    const { common, format } = await parseFile(file, { duration: true, skipCovers: true });
    return {
      title: common.title?.trim() || fb.title,
      artist: (common.artist || common.albumartist || fb.artist || '').trim(),
      album: (common.album || fb.album || '').trim(),
      genre: (common.genre?.[0] || '').trim(),
      year: common.year || null,
      track_no: common.track?.no || null,
      disc_no: common.disk?.no || null,
      duration: format.duration || 0,
    };
  } catch {
    return { ...fb, genre: '', year: null, track_no: null, disc_no: null, duration: 0 };
  }
}

// Run `fn` over `items` with at most `limit` in flight.
async function eachLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

export async function scanLibrary() {
  if (scanState.scanning) {
    rescanRequested = true;
    return;
  }
  Object.assign(scanState, { scanning: true, done: 0, total: 0, added: 0, updated: 0, removed: 0, error: null });

  try {
    const { music_folder } = getSettings();
    const root = music_folder ? resolveMediaPath(music_folder) : null;
    if (!root) {
      scanState.error = 'No music folder chosen';
      return;
    }
    try {
      if (!(await fs.stat(root)).isDirectory()) throw new Error();
    } catch {
      // Folder missing (drive unplugged, renamed...): keep the existing library untouched.
      scanState.error = `Music folder not found: ${music_folder}`;
      return;
    }

    const files = await walk(root, []);
    scanState.total = files.length;

    const existing = new Map(db.prepare('SELECT id, path, mtime, size FROM tracks').all().map((r) => [r.path, r]));
    const seen = new Set();
    const insert = db.prepare(`INSERT INTO tracks (path, mtime, size, title, artist, album, genre, year, track_no, disc_no, duration, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE tracks SET mtime = ?, size = ?, title = ?, artist = ?, album = ?, genre = ?, year = ?,
      track_no = ?, disc_no = ?, duration = ? WHERE id = ?`);

    let batch = [];
    const flush = () => {
      const rows = batch;
      batch = [];
      transaction(() => rows.forEach((fn) => fn()));
    };

    await eachLimit(files, 4, async (file) => {
      seen.add(file);
      try {
        const st = await fs.stat(file);
        const known = existing.get(file);
        if (known && known.mtime === st.mtimeMs && known.size === st.size) return;
        const t = await readTags(file, root);
        const values = [t.title, t.artist, t.album, t.genre, t.year, t.track_no, t.disc_no, t.duration];
        if (known) {
          batch.push(() => update.run(st.mtimeMs, st.size, ...values, known.id));
          scanState.updated++;
        } else {
          batch.push(() => insert.run(file, st.mtimeMs, st.size, ...values, Date.now()));
          scanState.added++;
        }
        if (batch.length >= 200) flush();
      } finally {
        scanState.done++;
      }
    });
    flush();

    const gone = [...existing.values()].filter((r) => !seen.has(r.path));
    if (gone.length) {
      const del = db.prepare('DELETE FROM tracks WHERE id = ?');
      transaction(() => gone.forEach((r) => del.run(r.id)));
      scanState.removed = gone.length;
    }
    scanState.lastScan = Date.now();
    console.log(`Scan complete: ${files.length} files, +${scanState.added} new, ${scanState.updated} updated, -${scanState.removed} removed`);
  } catch (err) {
    scanState.error = err.message;
    console.error('Scan failed:', err);
  } finally {
    scanState.scanning = false;
    if (rescanRequested) {
      rescanRequested = false;
      scanLibrary();
    }
  }
}
