# PLAYER_UI.md — Lighthouse player UI specs

Read this only for tasks about the player controls/overlay UI. Architecture and rules are in `AGENTS.md`.

The UI is refined incrementally. Change only what the task asks for. Use the existing font and icon system where possible.

## Design direction

Modern, minimal, premium. Dark/glass look, clean white line icons, consistent spacing, little clutter.

## Sizes and typography

| Element | Target |
|---|---|
| Main icons (10s back/forward, fullscreen, info, playback speed) | ~40–44px |
| Play/Pause icon | ~42px |
| Volume icon | ~36–40px |
| Main title | ~20px, weight 700 |
| Secondary title | ~20px, weight 400 |
| Remaining time | ~18–20px, weight 600–700 |

## Controls

**Play/Pause**: icon only. No circle, casing, border or filled background.

**Volume**
- Only the icon is visible normally.
- Vertical slider (~100px tall, ~6px wide) appears on hover/click.
- Red fill = current volume; red circular handle ~10–12px.
- Slider must stay usable while the pointer moves from icon to slider.

**Seek bar**
- Horizontal. Played progress red, with a red dot at the current position.
- Remaining time at the right end, numbers only, format `51:40`. No minus sign. No total duration.

**Buffered progress** (YouTube-style)
- Three layers: red played, subtle buffered behind it, unbuffered track.
- Example: position 30%, buffered 70% → 0–30% red, 30–70% subtle, 70–100% track.
- Must use real MPV buffering/cache info. Never fake it from the playback position.
- If MPV already exposes the property through the existing IPC, reuse it. Otherwise make the smallest addition needed.

**Title**
- Sits below the seek bar, horizontally centered in the player, independent of the left/right control groups.
- Not beside the volume button.
- The old top-left title was removed. Do not bring it back.

**Next Episode**
- TV episodes only, never movies.
- Right-side control group, immediately before the Episodes Switcher button.
- Not beside the centered title.
- Reuse the existing next-episode functionality.

**Playback speed**
- ~40–44px, modern and polished icon, not generic.
- Use the existing MPV/player control path. No new playback mechanism.
