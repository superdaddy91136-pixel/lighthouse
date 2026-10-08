# Lighthouse

A privacy-first IPTV player for Windows with a built-in MPV player and a modern, minimal interface.

Lighthouse is a fork of [Fred TV / open-tv](https://github.com/Fredolx/open-tv), customized with an embedded player and a redesigned experience.

<!-- Add your own screenshots here, e.g. ![Home](screenshots/lighthouse-home.png) -->

## Features

- **Embedded MPV player.** Playback runs inside the app window. No separate player window pops up.
- **Custom player controls.** Play/pause, 10-second seek, volume, fullscreen, playback speed and a seek bar with played and buffered progress.
- **Audio and subtitle menu**, with an adjustable subtitle size that is remembered across everything you watch.
- **Live TV** with an in-player channel switcher.
- **Movies and TV shows** with an in-player episode switcher, a Next Episode button, and resume playback.
- **Continue Watching** row on Home.
- **Cleaned-up titles.** Folder prefixes and years from your provider's names are removed in the player.
- **Multiple versions of a title** grouped together, selectable near Watch Now.
- **Fast startup.** Home loads from local data right away and refreshes in the background.
- **Playback stats** via the info button.

## Privacy

- No ads
- No analytics or tracking SDKs
- No accounts

Lighthouse does not include any content. It plays what your own IPTV provider supplies. Movie and show artwork and details may come from TMDB, but your provider stays the source for everything that plays.

## Download

Get the latest Windows installer from the [Releases](../../releases) page.

## Build from source

Requirements: Windows, [Node.js](https://nodejs.org), [pnpm](https://pnpm.io), [Rust](https://rustup.rs) and the Tauri v2 prerequisites.

```
pnpm install
pnpm tauri dev
```

To build the installer:

```
pnpm tauri build
```

On Windows PowerShell you may need `pnpm.cmd` instead of `pnpm`. The installers are created under `src-tauri\target\release\bundle\nsis\` and `src-tauri\target\release\bundle\msi\`.

## Tech stack

Tauri v2, Angular 17, Rust, WebView2, and MPV (`mpv.exe`).

## Credits and license

Lighthouse is based on [Fred TV / open-tv](https://github.com/Fredolx/open-tv) by Frédéric Lachapelle and its contributors. See the [LICENSE](LICENSE) file for the license terms, which also apply to this fork. MPV is a separate project with its own license.
