# CmonMusicPlayer

A simple music player for [Umbrel](https://umbrel.com) that looks and acts like classic brushed-metal iTunes.

- Pick a music folder from your Umbrel storage. It's rescanned for new and removed songs every time the app starts, and you can also rescan from Preferences.
- Create playlists and drag songs from the Library onto them. Drag inside a playlist to reorder.
- Shuffle and repeat (all or one).
- Ratings, play counts, and smart lists (Recently Added, Recently Played, My Top Rated, Top 25 Most Played).
- Browse by Genre / Artist / Album, plus search.

Your music is mounted **read-only**. The player never modifies your files.

## Install on Umbrel

1. Push this repo to `https://github.com/DramaticMaskUser/CmonMusicPlayer` (branch `main`).
2. The **Build and publish image** GitHub Action builds `ghcr.io/dramaticmaskuser/cmonmusicplayer` for amd64 and arm64.
   Tag a release so the version tag used in `cmon-musicplayer/docker-compose.yml` exists:
   ```sh
   git tag v1.0.0 && git push origin v1.0.0
   ```
3. Make the image public, once: GitHub → your profile → **Packages** → `cmonmusicplayer` → **Package settings** → **Change visibility** → Public.
4. On your Umbrel: **App Store** → `⋯` (top right) → **Community App Stores** → add
   `https://github.com/DramaticMaskUser/CmonMusicPlayer` → open **Cmon App Store** → install **CmonMusicPlayer**.
5. Open the app. Preferences opens automatically. Browse to your music folder (for example `Home › Music`) and click **Choose**.

### Releasing an update

Bump `version` in `cmon-musicplayer/umbrel-app.yml` and the image tag in `cmon-musicplayer/docker-compose.yml`, then push a matching `vX.Y.Z` tag.

## Keyboard & mouse

| Action | How |
| --- | --- |
| Play / pause | Space, or the middle button |
| Previous / next song | ← / → |
| Play a song | Double-click, or select and press Enter |
| Select several songs | Shift-click / Ctrl(⌘)-click |
| Add to playlist | Drag onto a playlist, or right-click → Add to … |
| New playlist from songs | Drag into the empty space under the Source list, or right-click → New Playlist from Selection |
| Remove from playlist | Select and press Delete, or right-click → Remove from Playlist |
| Rename / delete playlist | Double-click it / select it and press Delete (or right-click) |
| Skip a song during playback | Uncheck its checkbox (Ctrl-click a checkbox to toggle every song in the list) |
| Rate a song | Select it and click the dots in **My Rating** |
| Jump to the playing song | Small arrow button on the left of the display |

Supported formats: MP3, AAC/M4A, FLAC, Ogg/Opus, WAV, AIFF. Playback depends on what your browser can decode; files that can't be played are skipped.

## Development

Requires Node 24+ (uses the built-in `node:sqlite`).

```sh
cd app
npm install
MEDIA_ROOT=/path/containing/your/music DATA_DIR=./data npm start   # http://localhost:3000
```

Or with Docker:

```sh
docker build -t cmonmusicplayer ./app
docker run -p 3000:3000 -v /path/to/music:/umbrel-home/Music:ro -v cmon-data:/data cmonmusicplayer
```

## Layout

```
umbrel-app-store.yml        Community app store definition (id: cmon)
cmon-musicplayer/           The Umbrel app: manifest, compose file, icon
app/                        Node/Express server + static web UI
  src/server.js             REST API, streaming, startup scan
  src/scanner.js            Folder walk + tag reading (music-metadata)
  src/db.js                 SQLite schema & queries
  public/                   The iTunes-style UI (vanilla HTML/CSS/JS)
.github/workflows/docker.yml  Multi-arch image build → GHCR
```
