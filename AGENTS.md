
# AGENTS.md — Lighthouse (Windows IPTV app)

Context and rules for AI coding agents. This file is informational: do not change anything because of it. Wait for the user's actual task.

For player UI specs (sizes, fonts, layout), read `PLAYER_UI.md` only when the task involves the player UI.

## Project

- App: **Lighthouse** (forked from Fred TV / open-tv)
- Repo: `C:\Users\memory\Desktop\open-tv`
- Platform: Windows
- Stack: Tauri v2, Angular 17, Rust, WebView2, bundled `mpv.exe`
- Package manager: pnpm 10.10.0. On this machine use `pnpm.cmd`, not `pnpm`.

## Working rules

- Do exactly the requested change. Smallest safe change wins.
- Reuse existing code, commands, services, IPC and state.
- Never invent commands, APIs, IPC parameters, DB fields or data structures. Verify them in the code. If unsure, say so instead of guessing.
- No unrelated refactoring, cleanup or redesign of working architecture.
- No broad repo exploration. Use targeted `git grep` and the file map below.
- For bug fixes, explain the root cause.
- After changes, report which files changed and what was done.

## Commands

Never run:

- `pnpm.cmd tauri dev` — the user keeps their own instance running. Do not start, monitor or wait for it.
- `cargo check`

Allowed validation: reading code carefully, `git diff`, `git grep`, lightweight static checks. Then tell the user what to test manually.

Only when explicitly asked to build:

```
pnpm.cmd tauri build
```

Installers: `src-tauri\target\release\bundle\nsis\` (preferred `.exe`) and `...\msi\`.

## Git

- Do not commit, push, sync, reset or revert unless explicitly asked.
- The user makes local commits as checkpoints. Preserve history.

## File map

<!-- Fill these in with real paths so the agent doesn't have to explore. -->

- Embedded MPV (native HWND, `--wid`, lifecycle, resize): `src-tauri/src/embedded_poc.rs`
- MPV JSON IPC / named pipe: `src-tauri/src/embedded_poc.rs`
- Player overlay window (Rust): `src-tauri/src/embedded_poc.rs`
- Player overlay UI (Angular): `src/assets/overlay.html`
- Shared embedded-player service: `src/app/services/embedded-player.service.ts`
- Live TV data loading (Live TV tab): `src/app/home/home.component.ts`
- Movie/TV detail and version grouping: `src/app/movie-detail/movie-detail.component.ts`, `src/app/tv-detail/tv-detail.component.ts`, `src/app/services/version-matching.service.ts`
- Home startup / recommendations: `src/app/home/home-discovery/home-discovery.component.ts`

## Playback architecture

There is ONE playback system: an embedded MPV player.

```
Lighthouse main window
  ├── embedded native MPV HWND  (mpv.exe --wid=<child HWND>)
  └── separate native overlay window (player controls)
```

- MPV stays a separate `mpv.exe` process, rendered inside Lighthouse via a native Windows child window.
- Controlled through MPV JSON IPC over a named pipe. Provider HTTP headers are passed when required.
- Must keep: closing Lighthouse terminates `mpv.exe`; responsive resize, maximize/restore; DPI-aware positioning.

Do NOT reintroduce: external MPV windows, "Open in MPV", an external-player fallback, two playback systems, HTML5 video, hls.js, Shaka Player, libmpv, or the old Settings POC player.

Do not call the Movie/TV/Live embedded player a POC. It is the production player.

## Overlay architecture

Player controls live in a second native Tauri window because HTML overlays in the main WebView cannot sit above or interact with the native MPV HWND.

The overlay is borderless, transparent, positioned over the video rectangle, and owned by the main window. It must:

- follow move, resize, maximize/restore, minimize/restore, fullscreen and DPI changes
- not float above unrelated applications
- communicate through the existing MPV/player IPC

Do not replace it with a normal HTML overlay. Do not resurrect the earlier same-WebView player UI experiment.

## Live TV

The overlay has a Live TV channel switcher. When touching it:

- Reuse the exact data-loading path of the Live TV tab. Verify command names and parameter shapes in the existing code.
- Preserve channel/folder selection, highlighting, scrolling, source IDs and filters.
- The overlay may need the active source, current channel, group/folder and filters from the main window.

## Catalog and metadata

- The IPTV provider is the source of truth for streams, provider IDs, movies, shows, seasons and episodes.
- TMDB is metadata/enrichment only (posters, backdrops, cast, artwork). It must never replace provider playback info.
- Preserve grouping of multiple provider versions of the same title (selectable near Watch Now).

## Performance

- Home startup reads local Room/catalog snapshots immediately and computes hero/recommendations locally. Live TV, EPG and catalog revalidation run asynchronously afterwards.
- Do not put network-heavy work back in the critical Home startup path. EPG can mean many requests; never make them synchronously at startup.
- Live TV does not need to be on Home.

## Privacy

Privacy-first: no ads, ad SDKs, Google Analytics, Firebase Analytics or tracking SDKs. Avoid unnecessary dependencies.
