# Slipmat

Self-hosted web app for controlling and automating a Sonos system on the local network.
See the approved plan at `docs/PLAN.md`.

## ⚠️ Never touch real speakers without permission

**When running tests, spikes, scripts, or exploratory code, you must NEVER change anything on
real, on-network Sonos speakers unless explicitly asked, or you have specific permission for that
run.** This includes: starting or stopping playback, changing volume or mute, grouping or
ungrouping, modifying queues, saving or deleting Sonos playlists, and setting play modes.

- Automated tests run against the **fake Sonos layer** (`packages/server/src/sonos/fake/`) only.
  Never point a test suite at a real household.
- Read-only inspection of a real system (discovery, `Browse`, reading transport/volume state) is
  fine and does not need permission.
- Anything that mutates a real speaker — including the scratch-queue expansion used by the source
  resolver — needs an explicit ask first, naming which zone will be affected.
- If a task seems to require mutating real hardware to verify, stop and ask rather than assuming.

## Layout

- `packages/shared` — Zod schemas and inferred types, imported by server and web.
- `packages/server` — Fastify API, Sonos layer, SQLite (Drizzle), optional HomeKit bridge.
- `packages/web` — Vite + React + Tailwind v4 + shadcn/ui.

## Seeing the UI

`just screenshot [route] [output] [width] [height]` builds everything, boots the server against
the **fake household**, and captures the page with the headless Chromium that Playwright caches
(no browser dependency in this repo). Nothing real is touched.

`SLIPMAT_FAKE_SONOS=1` also works for interactive development — it seeds a grouped pair playing a
queue, a soundbar on TV audio, and an idle room, which is enough to exercise most UI states.

## Conventions

- Biome for lint and format (`just lint`, `just format`). Single quotes, no semicolons, 100 cols.
- All UPnP contact lives behind the interface in `packages/server/src/sonos/` — nothing else in
  the codebase talks to a speaker directly.
- The app models **zones** (rooms), never raw devices: bonded surrounds and subs are hidden and
  stereo pairs are a single entry.
- API reads are served from the in-memory `SystemState`, never from a synchronous UPnP call.
