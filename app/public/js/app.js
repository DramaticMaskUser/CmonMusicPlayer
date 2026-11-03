import { Player } from './player.js';

const ROW_H = 17;
const $ = (id) => document.getElementById(id);

const body = $('songs-body');
const rowsEl = $('songs-rows');
const header = $('songs-header');
const srcList = $('source-list');
const audio = $('audio');

const SMART = [
  { kind: 'recently-added', name: 'Recently Added' },
  { kind: 'recently-played', name: 'Recently Played' },
  { kind: 'top-rated', name: 'My Top Rated' },
  { kind: 'most-played', name: 'Top 25 Most Played' },
];

const COLUMNS = [
  { key: 'gutter', label: '', width: 18, fixed: true },
  { key: 'title', label: 'Song Name', width: 250 },
  { key: 'duration', label: 'Time', width: 52 },
  { key: 'artist', label: 'Artist', width: 170 },
  { key: 'album', label: 'Album', width: 170 },
  { key: 'genre', label: 'Genre', width: 110 },
  { key: 'rating', label: 'My Rating', width: 84 },
  { key: 'play_count', label: 'Play Count', width: 76 },
];

// ---------- small helpers ----------

const local = {
  get(key, def) {
    try {
      const v = localStorage.getItem('cmon.' + key);
      return v == null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('cmon.' + key, JSON.stringify(value));
    } catch {}
  },
};

async function api(method, url, data) {
  const res = await fetch('api/' + url, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} failed (${res.status})`);
  return res.status === 204 ? null : res.json();
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const sortKey = (s) => (s || '').replace(/^the\s+/i, '');
function cmpStr(a, b) {
  if (!a !== !b) return a ? -1 : 1; // blanks sort last
  return collator.compare(a, b);
}

const fmtNum = (n) => n.toLocaleString();

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtTotal(sec) {
  if (sec < 3600) {
    const m = Math.round(sec / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} hours`;
  return `${(sec / 86400).toFixed(1)} days`;
}

function fmtSize(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

// ---------- state ----------

const state = {
  tracks: new Map(),
  playlists: [],
  settings: {},
  scan: { scanning: false },
  source: { type: 'library' },
  sourceIds: [],
  entries: [], // visible rows: { id, pos, k, t }
  sort: local.get('sort', { key: 'artist', dir: 1 }),
  plSort: null, // null = playlist order
  selected: new Set(), // entry keys
  anchor: null,
  lead: null,
  filter: '',
  browse: { open: local.get('browse', false), genre: null, artist: null, album: null },
};

for (const c of COLUMNS) {
  const w = local.get('cols', {})[c.key];
  if (w) c.width = w;
}

const player = new Player(audio, {
  getTrack: (id) => state.tracks.get(id),
  onPlayed: async (id) => {
    try {
      mergeTrack(await api('POST', `tracks/${id}/played`));
    } catch {}
  },
});

function prepareTrack(t) {
  t._title = sortKey(t.title);
  t._artist = sortKey(t.artist);
  t._album = sortKey(t.album);
  t._search = `${t.title}\n${t.artist}\n${t.album}\n${t.genre}`.toLowerCase();
  return t;
}

function mergeTrack(t) {
  const existing = state.tracks.get(t.id);
  if (existing) Object.assign(existing, t);
  renderRows();
}

function sourceKey(src = state.source) {
  if (src.type === 'smart') return `smart:${src.kind}`;
  if (src.type === 'playlist') return `pl:${src.id}`;
  return 'library';
}

function parseKey(key) {
  if (key.startsWith('smart:')) return { type: 'smart', kind: key.slice(6) };
  if (key.startsWith('pl:')) return { type: 'playlist', id: Number(key.slice(3)) };
  return { type: 'library' };
}

const browseActive = () => state.browse.open && state.source.type === 'library';

// ---------- loading ----------

async function reloadLibrary() {
  const list = await api('GET', 'tracks');
  const map = new Map();
  for (const t of list) map.set(t.id, prepareTrack(t));
  state.tracks = map;
  await refreshPlaylists();
  await loadSource(true);
}

async function refreshPlaylists() {
  state.playlists = await api('GET', 'playlists');
  renderSources();
}

async function loadSource(keepScroll) {
  const src = state.source;
  let ids;
  try {
    if (src.type === 'library') ids = [...state.tracks.keys()];
    else if (src.type === 'smart') ids = await api('GET', `smart/${src.kind}`);
    else ids = await api('GET', `playlists/${src.id}/tracks`);
  } catch {
    if (src.type !== 'library') return selectSource('library');
    ids = [];
  }
  if (src !== state.source) return;
  state.sourceIds = ids;
  if (!keepScroll) body.scrollTop = 0;
  rebuildView();
}

function selectSource(key) {
  state.source = parseKey(key);
  state.selected.clear();
  state.anchor = state.lead = null;
  state.plSort = null;
  renderSources();
  return loadSource(false);
}

// ---------- view building ----------

function compareTracks(a, b, key) {
  const albumOrder = () =>
    cmpStr(a._album, b._album) || (a.disc_no || 0) - (b.disc_no || 0) || (a.track_no || 0) - (b.track_no || 0) || cmpStr(a._title, b._title);
  switch (key) {
    case 'title': return cmpStr(a._title, b._title) || cmpStr(a._artist, b._artist);
    case 'artist': return cmpStr(a._artist, b._artist) || albumOrder();
    case 'album': return albumOrder() || cmpStr(a._artist, b._artist);
    case 'genre': return cmpStr(a.genre, b.genre) || cmpStr(a._artist, b._artist) || albumOrder();
    case 'duration': return a.duration - b.duration || cmpStr(a._title, b._title);
    case 'rating': return a.rating - b.rating || cmpStr(a._artist, b._artist) || albumOrder();
    case 'play_count': return a.play_count - b.play_count || cmpStr(a._artist, b._artist) || albumOrder();
    default: return 0;
  }
}

function rebuildView() {
  const isPl = state.source.type === 'playlist';
  let entries = [];
  state.sourceIds.forEach((id, pos) => {
    const t = state.tracks.get(id);
    if (t) entries.push({ id, pos, k: isPl ? pos : id, t });
  });

  const terms = state.filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) entries = entries.filter((e) => terms.every((w) => e.t._search.includes(w)));

  if (browseActive()) {
    renderBrowser(entries);
    const { genre, artist, album } = state.browse;
    entries = entries.filter((e) =>
      (genre == null || e.t.genre === genre) &&
      (artist == null || e.t.artist === artist) &&
      (album == null || e.t.album === album));
  } else {
    $('browser').hidden = true;
  }
  $('btn-browse').classList.toggle('on', state.browse.open);

  const sort = state.source.type === 'library' ? state.sort : state.plSort;
  if (sort) entries.sort((a, b) => sort.dir * compareTracks(a.t, b.t, sort.key));

  state.entries = entries;
  renderHeader();
  renderRows();
  renderStatus();
}

// ---------- browser (Genre / Artist / Album) ----------

function uniqueSorted(entries, field) {
  return [...new Set(entries.map((e) => e.t[field]).filter(Boolean))]
    .sort((a, b) => collator.compare(sortKey(a), sortKey(b)));
}

function fillBrowserList(id, values, current, one, many) {
  const ul = $(id);
  ul._values = values;
  const label = `All (${fmtNum(values.length)} ${values.length === 1 ? one : many})`;
  ul.innerHTML =
    `<li data-i="-1" class="${current == null ? 'selected' : ''}">${esc(label)}</li>` +
    values.map((v, i) => `<li data-i="${i}" class="${v === current ? 'selected' : ''}">${esc(v)}</li>`).join('');
}

function renderBrowser(base) {
  $('browser').hidden = false;
  const b = state.browse;
  const genres = uniqueSorted(base, 'genre');
  if (b.genre != null && !genres.includes(b.genre)) b.genre = null;
  const byGenre = b.genre == null ? base : base.filter((e) => e.t.genre === b.genre);
  const artists = uniqueSorted(byGenre, 'artist');
  if (b.artist != null && !artists.includes(b.artist)) b.artist = null;
  const byArtist = b.artist == null ? byGenre : byGenre.filter((e) => e.t.artist === b.artist);
  const albums = uniqueSorted(byArtist, 'album');
  if (b.album != null && !albums.includes(b.album)) b.album = null;

  fillBrowserList('br-genre', genres, b.genre, 'Genre', 'Genres');
  fillBrowserList('br-artist', artists, b.artist, 'Artist', 'Artists');
  fillBrowserList('br-album', albums, b.album, 'Album', 'Albums');
}

for (const [id, field, resets] of [['br-genre', 'genre', ['artist', 'album']], ['br-artist', 'artist', ['album']], ['br-album', 'album', []]]) {
  $(id).addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const i = Number(li.dataset.i);
    state.browse[field] = i < 0 ? null : $(id)._values[i];
    for (const r of resets) state.browse[r] = null;
    body.scrollTop = 0;
    rebuildView();
  });
}

// ---------- song list ----------

function applyColumns() {
  const widths = COLUMNS.map((c) => c.width);
  const total = widths.reduce((a, b) => a + b, 0);
  const tpl = widths.map((w, i) => (i === widths.length - 1 ? `minmax(${w}px, 1fr)` : `${w}px`)).join(' ');
  $('songs').style.setProperty('--cols', tpl);
  rowsEl.style.width = `max(100%, ${total}px)`;
  $('songs-spacer').style.width = total + 'px';
}

function renderHeader() {
  const sort = state.source.type === 'library' ? state.sort : state.plSort;
  header.innerHTML = COLUMNS.map((c, i) => {
    const sorted = sort && sort.key === c.key ? ` sorted${sort.dir < 0 ? ' desc' : ''}` : '';
    const grip = c.fixed ? '' : `<span class="resize" data-i="${i}"></span>`;
    return `<div class="col${sorted}" data-key="${c.key}">${esc(c.label)}${grip}</div>`;
  }).join('');
}

function rowHtml(e, i, curId) {
  const t = e.t;
  const cls = 'row' + (state.selected.has(e.k) ? ' selected' : '') + (t.checked ? '' : ' unchecked');
  let stars = '';
  for (let r = 1; r <= 5; r++) stars += r <= t.rating ? `<i data-r="${r}">★</i>` : `<i data-r="${r}" class="off">·</i>`;
  return `<div class="${cls}" data-i="${i}" draggable="true">` +
    `<div class="c-gutter">${t.id === curId ? '<svg><use href="#i-speaker"/></svg>' : ''}</div>` +
    `<div class="c-name"><span class="check${t.checked ? ' on' : ''}"></span><span>${esc(t.title)}</span></div>` +
    `<div class="c-time">${t.duration ? fmtTime(t.duration) : ''}</div>` +
    `<div class="c-artist">${esc(t.artist)}</div>` +
    `<div class="c-album">${esc(t.album)}</div>` +
    `<div class="c-genre">${esc(t.genre)}</div>` +
    `<div class="c-rating">${stars}</div>` +
    `<div class="c-plays">${t.play_count || ''}</div>` +
    `</div>`;
}

function renderRows() {
  const n = state.entries.length;
  $('songs-spacer').style.height = n * ROW_H + 'px';
  const top = body.scrollTop;
  const first = Math.max(0, Math.floor(top / ROW_H) - 10);
  const last = Math.min(n, Math.ceil((top + (body.clientHeight || 800)) / ROW_H) + 10);
  rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
  const curId = player.current?.id;
  let html = '';
  for (let i = first; i < last; i++) html += rowHtml(state.entries[i], i, curId);
  rowsEl.innerHTML = html;
  header.style.paddingRight = body.offsetWidth - body.clientWidth + 'px';

  const empty = $('songs-empty');
  empty.hidden = n > 0;
  if (!n) {
    if (state.filter || (browseActive() && state.sourceIds.length)) empty.textContent = 'No matching songs';
    else if (state.source.type === 'playlist') empty.textContent = 'Drag songs from your Library here';
    else if (state.source.type === 'smart') empty.textContent = 'No songs yet';
    else if (state.scan.scanning) empty.textContent = 'Adding songs to your Library…';
    else if (!state.settings.music_folder) empty.innerHTML = 'Your Library is empty.<br>Click the Preferences button (bottom left) to choose your music folder.';
    else empty.textContent = 'No music found in the chosen folder';
  }
}

function refreshRowClasses() {
  for (const row of rowsEl.children) {
    const e = state.entries[Number(row.dataset.i)];
    row.classList.toggle('selected', !!e && state.selected.has(e.k));
  }
}

function renderStatus() {
  let secs = 0;
  let bytes = 0;
  for (const e of state.entries) {
    secs += e.t.duration || 0;
    bytes += e.t.size || 0;
  }
  const n = state.entries.length;
  $('status').textContent = n ? `${fmtNum(n)} song${n === 1 ? '' : 's'}, ${fmtTotal(secs)}, ${fmtSize(bytes)}` : '';
}

function ensureVisible(i) {
  const y = i * ROW_H;
  if (y < body.scrollTop) body.scrollTop = y;
  else if (y + ROW_H > body.scrollTop + body.clientHeight) body.scrollTop = y + ROW_H - body.clientHeight;
}

// ---------- selection ----------

function selectOnly(i) {
  state.selected = new Set([state.entries[i].k]);
  state.anchor = state.lead = i;
}

function selectRange(a, b, add) {
  if (!add) state.selected.clear();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selected.add(state.entries[i].k);
  state.lead = b;
}

const selectedEntries = () => state.entries.filter((e) => state.selected.has(e.k));
const firstSelectedIndex = () => state.entries.findIndex((e) => state.selected.has(e.k));

let pendingSingle = null;

rowsEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const i = Number(row.dataset.i);
  const entry = state.entries[i];
  body.focus({ preventScroll: true });

  if (e.target.closest('.check')) {
    e.preventDefault();
    toggleChecked(entry, e.ctrlKey || e.metaKey);
    return;
  }
  const star = e.target.closest('.c-rating i');
  if (star && (state.selected.has(entry.k) || entry.t.rating)) {
    e.preventDefault();
    const r = Number(star.dataset.r);
    setRating(entry.t, r === entry.t.rating ? 0 : r);
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (e.shiftKey && state.anchor != null) selectRange(state.anchor, i, mod);
  else if (mod) {
    if (state.selected.has(entry.k)) state.selected.delete(entry.k);
    else state.selected.add(entry.k);
    state.anchor = state.lead = i;
  } else if (!state.selected.has(entry.k)) selectOnly(i);
  else pendingSingle = i; // could be the start of a multi-row drag
  refreshRowClasses();
});

document.addEventListener('mouseup', () => {
  if (pendingSingle != null) {
    selectOnly(pendingSingle);
    pendingSingle = null;
    refreshRowClasses();
  }
});

rowsEl.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.row');
  if (!row || e.target.closest('.check, .c-rating')) return;
  playEntry(Number(row.dataset.i));
});

body.addEventListener('mousedown', (e) => {
  if (e.target === body || e.target.id === 'songs-spacer') {
    state.selected.clear();
    refreshRowClasses();
  }
});

let scrollQueued = false;
body.addEventListener('scroll', () => {
  header.scrollLeft = body.scrollLeft;
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    renderRows();
  });
});

body.addEventListener('keydown', (e) => {
  const n = state.entries.length;
  const mod = e.ctrlKey || e.metaKey;
  if (!n) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const lead = state.lead == null ? (step > 0 ? -1 : n) : state.lead;
    const next = Math.max(0, Math.min(n - 1, lead + step));
    if (e.shiftKey && state.anchor != null) selectRange(state.anchor, next, false);
    else selectOnly(next);
    ensureVisible(next);
    refreshRowClasses();
  } else if (e.key === 'Enter') {
    const i = firstSelectedIndex();
    if (i >= 0) playEntry(i);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removeSelectedFromPlaylist();
  } else if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    state.selected = new Set(state.entries.map((x) => x.k));
    refreshRowClasses();
  }
});

// ---------- header: sort & resize ----------

let justResized = false;

header.addEventListener('click', (e) => {
  if (justResized || e.target.classList.contains('resize')) return;
  const col = e.target.closest('.col');
  if (!col) return;
  const key = col.dataset.key;
  if (state.source.type === 'library') {
    if (key === 'gutter') return;
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: 1 };
    local.set('sort', state.sort);
  } else {
    const s = state.plSort;
    if (key === 'gutter') state.plSort = null;
    else state.plSort = !s || s.key !== key ? { key, dir: 1 } : s.dir > 0 ? { key, dir: -1 } : null;
  }
  rebuildView();
});

header.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.resize');
  if (!grip) return;
  e.preventDefault();
  const col = COLUMNS[Number(grip.dataset.i)];
  const startX = e.clientX;
  const startW = col.width;
  const move = (ev) => {
    col.width = Math.max(30, startW + ev.clientX - startX);
    applyColumns();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    local.set('cols', Object.fromEntries(COLUMNS.map((c) => [c.key, c.width])));
    justResized = true;
    setTimeout(() => (justResized = false), 0);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
});

// ---------- track edits ----------

function toggleChecked(entry, all) {
  const val = entry.t.checked ? 0 : 1;
  const targets = all ? state.entries.map((e) => e.t) : [entry.t];
  for (const t of targets) t.checked = val;
  renderRows();
  api('PATCH', 'tracks', { ids: [...new Set(targets.map((t) => t.id))], checked: !!val }).catch(console.error);
}

function setRating(t, rating) {
  t.rating = rating;
  renderRows();
  api('PATCH', `tracks/${t.id}`, { rating }).catch(console.error);
}

// ---------- playback ----------

function playEntry(i) {
  player.playList(state.entries.map((e) => e.id), i, sourceKey());
}

function playPressed() {
  if (player.current) return player.toggle();
  if (!state.entries.length) return;
  const i = firstSelectedIndex();
  player.playList(state.entries.map((e) => e.id), i >= 0 ? i : null, sourceKey());
}

async function showCurrent() {
  const t = player.current;
  if (!t) return;
  const key = player.sourceKey || 'library';
  if (key !== sourceKey()) {
    const exists = !key.startsWith('pl:') || state.playlists.some((p) => `pl:${p.id}` === key);
    await selectSource(exists ? key : 'library');
  }
  let i = state.entries.findIndex((e) => e.id === t.id);
  if (i < 0 && (state.filter || browseActive())) {
    state.filter = $('search').value = '';
    Object.assign(state.browse, { genre: null, artist: null, album: null });
    rebuildView();
    i = state.entries.findIndex((e) => e.id === t.id);
  }
  if (i < 0) return;
  selectOnly(i);
  body.scrollTop = Math.max(0, i * ROW_H - body.clientHeight / 2);
  renderRows();
  body.focus({ preventScroll: true });
}

// ---------- source list ----------

function renderSources() {
  const current = sourceKey();
  const item = (key, icon, name) =>
    `<li data-key="${key}" class="${key === current ? 'selected' : ''}"><svg><use href="#i-${icon}"/></svg><span class="name">${esc(name)}</span></li>`;
  srcList.innerHTML =
    item('library', 'library', 'Library') +
    SMART.map((s) => item(`smart:${s.kind}`, 'smart', s.name)).join('') +
    state.playlists.map((p) => item(`pl:${p.id}`, 'playlist', p.name)).join('');
}

srcList.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (!li || li.querySelector('input')) return;
  if (li.dataset.key !== sourceKey()) selectSource(li.dataset.key);
});

srcList.addEventListener('dblclick', (e) => {
  const li = e.target.closest('li');
  if (li?.dataset.key.startsWith('pl:')) startRename(Number(li.dataset.key.slice(3)));
});

srcList.addEventListener('keydown', (e) => {
  const items = [...srcList.querySelectorAll('li')];
  const idx = items.findIndex((li) => li.dataset.key === sourceKey());
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) selectSource(next.dataset.key);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.source.type === 'playlist') {
    e.preventDefault();
    deletePlaylist(state.source.id);
  } else if (e.key === 'Enter' && state.source.type === 'playlist') {
    e.preventDefault();
    startRename(state.source.id);
  }
});

srcList.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  const key = li.dataset.key;
  const go = async (fn) => {
    if (key !== sourceKey()) await selectSource(key);
    fn();
  };
  const items = [{ label: 'Play', action: () => go(() => playPressedFresh()) }];
  if (key.startsWith('pl:')) {
    const id = Number(key.slice(3));
    items.push('-', { label: 'Rename', action: () => go(() => startRename(id)) }, { label: 'Delete', action: () => deletePlaylist(id) });
  }
  showMenu(e.clientX, e.clientY, items);
});

// Start the current list from the top (or randomly when shuffling), ignoring what's loaded.
function playPressedFresh() {
  if (state.entries.length) player.playList(state.entries.map((e) => e.id), null, sourceKey());
}

function startRename(id) {
  const li = srcList.querySelector(`li[data-key="pl:${id}"]`);
  if (!li) return;
  const span = li.querySelector('.name');
  const old = span.textContent;
  const input = document.createElement('input');
  input.value = old;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    try {
      if (save && name && name !== old) await api('PATCH', `playlists/${id}`, { name });
    } finally {
      await refreshPlaylists();
      srcList.focus();
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

async function newPlaylist(trackIds = []) {
  const pl = await api('POST', 'playlists', { name: 'untitled playlist', trackIds });
  await refreshPlaylists();
  await selectSource(`pl:${pl.id}`);
  startRename(pl.id);
}

async function deletePlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl || !confirm(`Are you sure you want to delete the playlist “${pl.name}”?`)) return;
  await api('DELETE', `playlists/${id}`);
  if (sourceKey() === `pl:${id}`) await selectSource('library');
  await refreshPlaylists();
}

async function addToPlaylist(id, trackIds, index) {
  await api('POST', `playlists/${id}/tracks`, { trackIds, index });
  await refreshPlaylists();
  if (sourceKey() === `pl:${id}`) await loadSource(true);
}

async function removeSelectedFromPlaylist() {
  if (state.source.type !== 'playlist') return;
  const positions = selectedEntries().map((e) => e.pos);
  if (!positions.length) return;
  await api('DELETE', `playlists/${state.source.id}/tracks`, { positions });
  state.selected.clear();
  await refreshPlaylists();
  await loadSource(true);
}

// ---------- drag & drop ----------

let drag = null;

rowsEl.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  pendingSingle = null;
  const i = Number(row.dataset.i);
  if (!state.selected.has(state.entries[i].k)) {
    selectOnly(i);
    refreshRowClasses();
  }
  const sel = selectedEntries();
  drag = { trackIds: sel.map((x) => x.id), positions: sel.map((x) => x.pos), fromKey: sourceKey() };
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', sel.map((x) => x.t.title).join('\n'));
  const ghost = $('drag-ghost');
  ghost.textContent = sel.length === 1 ? sel[0].t.title : `${sel.length} songs`;
  e.dataTransfer.setDragImage(ghost, -12, -6);
  srcList.classList.add('dragging');
});

function clearDropTargets() {
  srcList.querySelectorAll('.drop-target').forEach((li) => li.classList.remove('drop-target'));
  srcList.classList.remove('drop-new');
  $('drop-line').hidden = true;
}

document.addEventListener('dragend', () => {
  drag = null;
  clearDropTargets();
  srcList.classList.remove('dragging');
});

srcList.addEventListener('dragover', (e) => {
  if (!drag) return;
  const li = e.target.closest('li');
  clearDropTargets();
  if (li && li.dataset.key.startsWith('pl:')) {
    li.classList.add('drop-target');
  } else if (!li) {
    srcList.classList.add('drop-new');
  } else {
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

srcList.addEventListener('dragleave', (e) => {
  if (!srcList.contains(e.relatedTarget)) clearDropTargets();
});

srcList.addEventListener('drop', async (e) => {
  if (!drag) return;
  e.preventDefault();
  const li = e.target.closest('li');
  const { trackIds } = drag;
  clearDropTargets();
  if (li && li.dataset.key.startsWith('pl:')) await addToPlaylist(Number(li.dataset.key.slice(3)), trackIds);
  else if (!li) await newPlaylist(trackIds);
});

// Dropping onto the song list of a playlist (insert or reorder).
function playlistDropIndex(e) {
  if (!drag || state.source.type !== 'playlist' || state.plSort || state.filter) return null;
  const rect = body.getBoundingClientRect();
  const y = e.clientY - rect.top;
  if (y < 20) body.scrollTop -= ROW_H;
  else if (y > rect.height - 20) body.scrollTop += ROW_H;
  return Math.max(0, Math.min(state.entries.length, Math.round((y + body.scrollTop) / ROW_H)));
}

body.addEventListener('dragover', (e) => {
  const idx = playlistDropIndex(e);
  if (idx == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = drag.fromKey === sourceKey() ? 'move' : 'copy';
  const line = $('drop-line');
  line.hidden = false;
  line.style.top = idx * ROW_H - 1 + 'px';
});

body.addEventListener('dragleave', (e) => {
  if (!body.contains(e.relatedTarget)) $('drop-line').hidden = true;
});

body.addEventListener('drop', async (e) => {
  const idx = playlistDropIndex(e);
  if (idx == null) return;
  e.preventDefault();
  $('drop-line').hidden = true;
  const d = drag; // `dragend` clears `drag` while we await below
  const id = state.source.id;
  let start;
  let count;
  if (d.fromKey === sourceKey()) {
    const moving = new Set(d.positions);
    const kept = [];
    let insertAt = 0;
    state.sourceIds.forEach((tid, p) => {
      if (moving.has(p)) return;
      if (p < idx) insertAt++;
      kept.push(tid);
    });
    const moved = [...moving].sort((a, b) => a - b).map((p) => state.sourceIds[p]);
    kept.splice(insertAt, 0, ...moved);
    await api('PUT', `playlists/${id}/tracks`, { trackIds: kept });
    [start, count] = [insertAt, moved.length];
  } else {
    await api('POST', `playlists/${id}/tracks`, { trackIds: d.trackIds, index: idx });
    [start, count] = [idx, d.trackIds.length];
    await refreshPlaylists();
  }
  await loadSource(true);
  state.selected = new Set(Array.from({ length: count }, (_, j) => start + j));
  state.anchor = state.lead = start;
  refreshRowClasses();
});

// ---------- context menu ----------

const menu = $('context-menu');

function showMenu(x, y, items) {
  menu._items = items;
  menu.innerHTML = items.map((it, i) => (it === '-' ? '<li class="sep"></li>' : `<li data-i="${i}">${esc(it.label)}</li>`)).join('');
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}

const hideMenu = () => (menu.hidden = true);

menu.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  hideMenu();
  menu._items[Number(li.dataset.i)].action();
});
document.addEventListener('mousedown', (e) => {
  if (!menu.contains(e.target)) hideMenu();
}, true);
window.addEventListener('blur', hideMenu);

rowsEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const i = Number(row.dataset.i);
  if (!state.selected.has(state.entries[i].k)) {
    selectOnly(i);
    refreshRowClasses();
  }
  const sel = selectedEntries();
  const ids = sel.map((x) => x.id);
  const items = [{ label: 'Play', action: () => playEntry(state.entries.indexOf(sel[0])) }, '-'];
  for (const p of state.playlists) {
    if (sourceKey() !== `pl:${p.id}`) items.push({ label: `Add to “${p.name}”`, action: () => addToPlaylist(p.id, ids) });
  }
  items.push({ label: 'New Playlist from Selection', action: () => newPlaylist(ids) });
  if (state.source.type === 'playlist') items.push('-', { label: 'Remove from Playlist', action: removeSelectedFromPlaylist });
  showMenu(e.clientX, e.clientY, items);
});

// ---------- LCD ----------

let lcdCycle = 0;
let showRemaining = false;
let lcdMessage = null;

function renderLCD() {
  const t = player.current;
  const scan = state.scan;
  const idle = $('lcd-idle');
  const lcdBody = $('lcd-body');
  const line1 = $('lcd-line1');
  const line2 = $('lcd-line2');
  const prog = $('lcd-progress');

  if (!t && scan.scanning) {
    idle.hidden = true;
    lcdBody.hidden = false;
    line1.textContent = 'Updating Library…';
    line2.textContent = scan.total ? `${fmtNum(scan.done)} of ${fmtNum(scan.total)} files` : 'Looking for music…';
    line1.classList.remove('clickable');
    line2.classList.remove('clickable');
    prog.className = 'lcd-progress scanning';
    $('lcd-fill').style.width = scan.total ? (scan.done / scan.total) * 100 + '%' : '0';
    return;
  }
  if (!t) {
    idle.hidden = false;
    lcdBody.hidden = true;
    return;
  }
  idle.hidden = true;
  lcdBody.hidden = false;
  line1.classList.add('clickable');
  line2.classList.add('clickable');
  const info = [t.title, t.artist, t.album].filter(Boolean);
  line1.textContent = info[lcdCycle % info.length];
  const cur = audio.currentTime || 0;
  const dur = Number.isFinite(audio.duration) ? audio.duration : t.duration;
  if (lcdMessage && lcdMessage.until > Date.now()) line2.textContent = lcdMessage.text;
  else line2.textContent = showRemaining ? `Remaining Time: -${fmtTime(dur - cur)}` : `Elapsed Time: ${fmtTime(cur)}`;
  prog.className = 'lcd-progress';
  $('lcd-head').style.left = (dur ? Math.min(100, (cur / dur) * 100) : 0) + '%';
}

$('lcd-line1').addEventListener('click', () => {
  lcdCycle++;
  renderLCD();
});
$('lcd-line2').addEventListener('click', () => {
  showRemaining = !showRemaining;
  renderLCD();
});
setInterval(() => {
  if (player.playing) {
    lcdCycle++;
    renderLCD();
  }
}, 4000);

$('lcd-progress').addEventListener('pointerdown', (e) => {
  if (!player.current) return;
  const prog = e.currentTarget;
  const seekTo = (ev) => {
    const r = prog.getBoundingClientRect();
    player.seek((ev.clientX - r.left) / r.width);
  };
  seekTo(e);
  prog.setPointerCapture(e.pointerId);
  const move = (ev) => seekTo(ev);
  prog.addEventListener('pointermove', move);
  prog.addEventListener('pointerup', () => prog.removeEventListener('pointermove', move), { once: true });
});

// ---------- player wiring ----------

let lastCurId = null;
player.addEventListener('change', () => {
  const t = player.current;
  const id = t?.id ?? null;
  if (id !== lastCurId) {
    lastCurId = id;
    lcdCycle = 0;
    renderRows();
    document.title = t ? `${t.title} – CmonMusicPlayer` : 'CmonMusicPlayer';
  }
  $('play-glyph').setAttribute('href', player.playing ? '#i-pause' : '#i-play');
  $('btn-play').title = player.playing ? 'Pause' : 'Play';
  $('btn-shuffle').classList.toggle('on', player.shuffle);
  $('btn-repeat').classList.toggle('on', player.repeat !== 'off');
  $('repeat-one').hidden = player.repeat !== 'one';
  renderLCD();
});

player.addEventListener('error', (e) => {
  lcdMessage = { text: `Can't play “${e.detail?.title ?? 'this file'}”`, until: Date.now() + 2500 };
  renderLCD();
});

let saveTimer;
function saveSettings(patch) {
  Object.assign(state.settings, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('PUT', 'settings', patch).catch(console.error), 400);
}

$('btn-play').addEventListener('click', playPressed);
$('btn-prev').addEventListener('click', () => player.prev());
$('btn-next').addEventListener('click', () => player.next());
$('btn-snap').addEventListener('click', showCurrent);
$('volume').addEventListener('input', (e) => {
  player.setVolume(Number(e.target.value));
  saveSettings({ volume: Number(e.target.value) });
});
$('btn-shuffle').addEventListener('click', () => {
  player.setShuffle(!player.shuffle);
  saveSettings({ shuffle: player.shuffle });
});
$('btn-repeat').addEventListener('click', () => {
  const next = { off: 'all', all: 'one', one: 'off' }[player.repeat];
  player.setRepeat(next);
  saveSettings({ repeat: next });
});
$('btn-new').addEventListener('click', () => newPlaylist());
$('btn-prefs').addEventListener('click', openPrefs);
$('btn-browse').addEventListener('click', async () => {
  state.browse.open = !state.browse.open;
  local.set('browse', state.browse.open);
  if (state.browse.open && state.source.type !== 'library') await selectSource('library');
  else rebuildView();
});
$('search').addEventListener('input', (e) => {
  state.filter = e.target.value;
  body.scrollTop = 0;
  rebuildView();
});

// Keep toolbar buttons from stealing focus (so Space keeps meaning play/pause).
document.querySelectorAll('.round, .square, .lcd-snap').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (!$('prefs').hidden) {
    if (e.key === 'Escape') closePrefs();
    return;
  }
  if (e.key === 'Escape') hideMenu();
  else if (e.key === ' ') {
    e.preventDefault();
    playPressed();
  } else if (e.key === 'ArrowRight') player.next();
  else if (e.key === 'ArrowLeft') player.prev();
});

// ---------- splitter ----------

const pane = $('source-pane');
const savedPaneW = local.get('sourceW', null);
if (savedPaneW) pane.style.width = savedPaneW + 'px';

$('splitter').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = pane.offsetWidth;
  const move = (ev) => {
    pane.style.width = Math.max(110, Math.min(420, startW + ev.clientX - startX)) + 'px';
    renderRows();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', () => {
    window.removeEventListener('pointermove', move);
    local.set('sourceW', pane.offsetWidth);
  }, { once: true });
});

window.addEventListener('resize', () => renderRows());

// ---------- preferences ----------

let browsePath = '/';

async function openPrefs() {
  $('prefs').hidden = false;
  renderPrefsInfo();
  await showDir(state.settings.music_folder || '/');
}

function closePrefs() {
  $('prefs').hidden = true;
}

async function showDir(p) {
  let res;
  try {
    res = await api('GET', `browse?path=${encodeURIComponent(p)}`);
  } catch {
    if (p !== '/') return showDir('/');
    res = { path: '/', dirs: [] };
  }
  browsePath = res.path;
  const parts = browsePath.split('/').filter(Boolean);
  $('pref-crumbs').innerHTML =
    '<a data-p="/">Home</a>' +
    parts.map((part, i) => `<span>›</span><a data-p="/${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</a>`).join('');
  const base = browsePath === '/' ? '' : browsePath;
  $('pref-dirs').innerHTML = res.dirs.length
    ? res.dirs.map((d) => `<li data-p="${esc(`${base}/${d}`)}"><svg><use href="#i-folder"/></svg>${esc(d)}</li>`).join('')
    : '<li class="empty">No folders inside</li>';
  $('pref-choose').textContent = `Choose “${parts.at(-1) || 'Home'}”`;
}

function renderPrefsInfo() {
  const f = state.settings.music_folder;
  $('pref-folder').textContent = f ? `Home${f === '/' ? '' : f}` : '(none chosen yet)';
  const s = state.scan;
  const el = $('pref-scan');
  el.classList.toggle('error', !!s.error && !s.scanning);
  if (s.scanning) el.textContent = s.total ? `Scanning… ${fmtNum(s.done)} of ${fmtNum(s.total)} files` : 'Scanning…';
  else if (s.error) el.textContent = s.error;
  else if (s.lastScan) {
    el.textContent = `Last scan ${new Date(s.lastScan).toLocaleString()}: ${fmtNum(state.tracks.size)} songs` +
      (s.added || s.removed ? ` (${fmtNum(s.added)} added, ${fmtNum(s.removed)} removed)` : '');
  } else el.textContent = '';
}

$('pref-crumbs').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (a) showDir(a.dataset.p);
});
$('pref-dirs').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-p]');
  if (li) showDir(li.dataset.p);
});
$('pref-choose').addEventListener('click', async () => {
  state.settings = await api('PUT', 'settings', { music_folder: browsePath });
  state.scan = { ...state.scan, scanning: true, done: 0, total: 0, error: null };
  renderPrefsInfo();
  renderLCD();
  pollStatus();
});
$('pref-rescan').addEventListener('click', async () => {
  await api('POST', 'rescan');
  state.scan = { ...state.scan, scanning: true, done: 0, total: 0, error: null };
  renderPrefsInfo();
  pollStatus();
});
$('pref-done').addEventListener('click', closePrefs);
$('prefs').addEventListener('mousedown', (e) => {
  if (e.target.id === 'prefs') closePrefs();
});

// ---------- status polling ----------

let pollTimer;
let pollCount = 0;

async function pollStatus() {
  clearTimeout(pollTimer);
  try {
    const s = await api('GET', 'status');
    const wasScanning = state.scan.scanning;
    state.scan = s.scan;
    if (s.scan.scanning) {
      // Show songs as they're found during a long first scan.
      if (++pollCount % 6 === 0) await reloadLibrary();
    } else if (wasScanning || s.trackCount !== state.tracks.size) {
      await reloadLibrary();
    }
  } catch {}
  renderLCD();
  renderPrefsInfo();
  if (!state.entries.length) renderRows();
  pollTimer = setTimeout(pollStatus, state.scan.scanning ? 700 : 10000);
}

// ---------- boot ----------

async function init() {
  applyColumns();
  state.settings = await api('GET', 'settings');
  $('volume').value = state.settings.volume;
  player.setVolume(state.settings.volume);
  player.setShuffle(!!state.settings.shuffle);
  player.setRepeat(state.settings.repeat || 'off');
  await reloadLibrary();
  await pollStatus();
  if (!state.settings.music_folder) openPrefs();
}

init().catch((err) => {
  console.error(err);
  $('songs-empty').hidden = false;
  $('songs-empty').textContent = "Couldn't reach the CmonMusicPlayer server.";
});
