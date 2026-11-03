// Playback engine: owns the <audio> element and the play queue.
//
// The queue is a snapshot of the list the user started playing from (`list`,
// an array of track ids). `order` holds indices into `list` in the order they
// will play - identity order normally, a Fisher-Yates shuffle when shuffle is on.

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Player extends EventTarget {
  constructor(audio, { getTrack, onPlayed }) {
    super();
    this.audio = audio;
    this.getTrack = getTrack;
    this.onPlayed = onPlayed;
    this.list = [];
    this.order = [];
    this.pos = -1;
    this.sourceKey = null;
    this.shuffle = false;
    this.repeat = 'off'; // off | all | one
    this.failures = 0;

    audio.addEventListener('ended', () => this.handleEnded());
    audio.addEventListener('error', () => this.handleError());
    audio.addEventListener('playing', () => { this.failures = 0; });
    for (const ev of ['play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata']) {
      audio.addEventListener(ev, () => this.emit());
    }
    this.setupMediaSession();
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }

  get current() {
    return this.pos >= 0 ? this.getTrack(this.list[this.order[this.pos]]) : null;
  }

  get playing() {
    return !this.audio.paused && !!this.current;
  }

  isPlayable(index) {
    const t = this.getTrack(this.list[index]);
    return t && t.checked;
  }

  // Start playing `ids` (from source `sourceKey`). `start` is the index in ids
  // to begin with, or null to start at the top (or anywhere, when shuffling).
  playList(ids, start, sourceKey) {
    this.list = ids.slice();
    this.sourceKey = sourceKey;
    if (!this.list.length) return this.stop();
    const all = this.list.map((_, i) => i);
    if (this.shuffle) {
      if (start == null) {
        this.order = shuffled(all.filter((i) => this.isPlayable(i)));
      } else {
        this.order = [start, ...shuffled(all.filter((i) => i !== start && this.isPlayable(i)))];
      }
    } else {
      this.order = all;
    }
    let pos = start == null ? 0 : this.order.indexOf(start);
    // Unchecked songs are skipped unless explicitly chosen.
    if (start == null) pos = this.findPlayable(pos, 1);
    if (pos < 0) return this.stop();
    this.load(pos);
  }

  findPlayable(from, step) {
    for (let p = from; p >= 0 && p < this.order.length; p += step) {
      if (this.isPlayable(this.order[p])) return p;
    }
    return -1;
  }

  load(pos, autoplay = true) {
    this.pos = pos;
    const track = this.current;
    if (!track) return this.stop();
    this.audio.src = `api/tracks/${track.id}/stream`;
    if (autoplay) this.audio.play().catch(() => {});
    this.updateMediaSession();
    this.emit();
  }

  toggle() {
    if (!this.current) return false;
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
    return true;
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.pos = -1;
    this.updateMediaSession();
    this.emit();
  }

  next(auto = false) {
    if (!this.current) return;
    if (auto && this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
      return;
    }
    let p = this.findPlayable(this.pos + 1, 1);
    if (p < 0 && this.repeat === 'all') {
      if (this.shuffle) this.order = shuffled(this.order);
      p = this.findPlayable(0, 1);
    }
    if (p < 0) {
      // End of the list: stop and rewind to the first song, like iTunes.
      if (auto) {
        this.stop();
      } else {
        this.load(this.findPlayable(0, 1), false);
      }
      return;
    }
    this.load(p, auto || !this.audio.paused);
  }

  prev() {
    if (!this.current) return;
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    let p = this.findPlayable(this.pos - 1, -1);
    if (p < 0 && this.repeat === 'all') p = this.findPlayable(this.order.length - 1, -1);
    if (p < 0) {
      this.audio.currentTime = 0;
      return;
    }
    this.load(p, !this.audio.paused);
  }

  seek(fraction) {
    const d = this.audio.duration;
    if (Number.isFinite(d)) this.audio.currentTime = Math.max(0, Math.min(d, d * fraction));
  }

  setVolume(v) {
    this.audio.volume = Math.max(0, Math.min(1, v));
  }

  setShuffle(on) {
    this.shuffle = on;
    if (this.pos < 0) return this.emit();
    const cur = this.order[this.pos];
    const all = this.list.map((_, i) => i);
    if (on) {
      this.order = [cur, ...shuffled(all.filter((i) => i !== cur))];
      this.pos = 0;
    } else {
      this.order = all;
      this.pos = cur;
    }
    this.emit();
  }

  setRepeat(mode) {
    this.repeat = mode;
    this.emit();
  }

  handleEnded() {
    const track = this.current;
    if (track) this.onPlayed(track.id);
    this.next(true);
  }

  handleError() {
    if (!this.audio.getAttribute('src') || this.pos < 0) return;
    this.failures++;
    this.dispatchEvent(new CustomEvent('error', { detail: this.current }));
    // Skip files the browser can't decode, but don't spin forever.
    if (this.failures < Math.min(this.order.length, 10)) {
      setTimeout(() => this.next(true), 600);
    } else {
      this.stop();
    }
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.toggle());
    ms.setActionHandler('pause', () => this.toggle());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('nexttrack', () => this.next());
  }

  updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = this.current;
    navigator.mediaSession.metadata = t
      ? new MediaMetadata({ title: t.title, artist: t.artist, album: t.album })
      : null;
  }
}
