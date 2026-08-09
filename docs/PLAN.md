# Domovoi — self-hosted Sonos control & automation

## Context

There is no good self-hosted way to say "start *this* set of speakers, at *these* volumes, playing *these* playlists shuffled together" and then trigger it from a phone, a webhook, or HomeKit. The Sonos app can't do it; `node-sonos-http-api` gets partway there but is dormant, UI-less, and its flat JSON presets can't express multi-source shuffle.

Domovoi is a Docker container on the LAN that owns a live picture of the Sonos system and exposes:

1. A simple web UI for everyday playback — play/pause/skip/seek, volume, group/ungroup.
2. **Presets** — the core feature: named automations that group speakers, set per-speaker volumes, and start playback of a track pool shuffled together from several playlists / albums / favourites.
3. Three ways to fire a preset: UI buttons, webhooks, and (optional) HomeKit switches that also *report* whether the preset is playing and can stop it.
4. A **Pause All Music** action that silences the house without touching TV audio.

`/Users/alex/Developer/Domovoi` is an empty git repo — greenfield.

## Research outcome: build on `@svrooij/sonos`, not `node-sonos-http-api`

| | `jishi/node-sonos-http-api` | `svrooij/node-sonos-ts` (`@svrooij/sonos`) |
|---|---|---|
| Activity | last commit **Mar 2025**, 199 open issues | commits **Jul 2026**, 1 open issue |
| Language | plain JS | TypeScript, generated full UPnP client |
| Events | ad-hoc | strongly-typed service subscriptions |
| Shape | opinionated HTTP server | **library** — what we want |

`node-sonos-http-api` stays a *design reference* — its preset semantics (`players` + `volume`, `favorite`/`playlist`/`uri`, `pauseOthers`, `shuffle`/`repeat`/`crossfade`) are well-shaped and worth borrowing. But wrapping a dormant JS server and talking to it over localhost HTTP buys nothing: we still need our own state store, DB, event model and multi-source resolver, and the riskiest part of this project (source resolution) would live in code we can't type or extend.

## Stack

pnpm monorepo, single image.

- `packages/shared` — Zod schemas + inferred types, imported by both sides.
- `packages/server` — Fastify 5, TypeScript, `@svrooij/sonos`, `better-sqlite3` + Drizzle, `@homebridge/hap-nodejs`, pino.
- `packages/web` — Vite + React + Tailwind v4 + **shadcn/ui**, TanStack Query, react-hook-form + zod, WebSocket for live state.
- Biome for lint/format. Vitest against a faked Sonos layer.
- Multi-stage `Dockerfile` → `node:22-bookworm-slim` (builder compiles `better-sqlite3`), multi-arch amd64/arm64 to GHCR. Data in `/data`.

Plain REST + Zod, no tRPC — webhooks and Shortcuts-style clients need a boring HTTP surface anyway.

**`network_mode: host` is a hard requirement** — SSDP discovery, UPnP event callbacks the speakers must dial back into, and HomeKit mDNS all need it. `DOMOVOI_SEED_IP` gives a discovery fallback, and the advertised callback host/port is configurable.

## Architecture

### Sonos layer (`server/sonos/`)
`SonosManager` initialised by SSDP discovery with the seed-IP fallback. Subscribe per device to **AVTransport** (transport state, current track), **RenderingControl** (volume/mute) and **ZoneGroupTopology** (grouping); fold events into an in-memory `SystemState` and push diffs to the UI over WebSocket. Every API read comes from this store — no synchronous UPnP on the read path.

A **reconciliation loop** renews UPnP subscriptions before their ~10 minute expiry, re-subscribes to speakers that rebooted, and picks up new devices. All UPnP contact is behind our own interface so a future transport swap is contained.

**Zones, not devices.** The whole app models *zones* (rooms): bonded surrounds and subs are hidden, stereo pairs appear as one entry. Otherwise you can build a preset that targets a subwoofer.

### Source resolution (`server/sources/`) — the risky part
A preset holds ordered `sources[]`, each one of `sonos_playlist` (`SQ:n`) | `sonos_favorite` (`FV:2/…`) | `library_container` (`A:ALBUM/…`) | `service_url` (pasted Spotify/Apple share URL) | `raw_uri`. The resolver turns each into concrete per-track URIs + DIDL metadata:

- **Containers Sonos can browse** (playlists, favourites, library) → paginated `ContentDirectory.BrowseParsed`. Direct and cheap.
- **Pasted service URLs** → normalise to a service URI (`spotify:playlist:…`, Apple catalog/library ids), then expand. Two approaches, tried in order during the spike:
  1. **SMAPI browse** via `MusicServicesService` + a household session id — the "proper" route.
  2. **Scratch-queue expansion** — `AddURIToQueue(container)` on a utility player, `Browse("Q:0")` to read back the per-track URIs Sonos itself expanded, then restore. Service-agnostic and the likelier winner.
- Resolved lists are **cached in SQLite** with a TTL, refreshed in the background (never on the activation path) plus a manual refresh button.

**M3 spike result (validated against a real household, 2026-08-09): scratch-queue
expansion works.** An Apple Music library-playlist favourite expanded into 25
individual track URIs on a real speaker, which was then restored. Three details
turned out to be load-bearing and are now covered by tests:

- Browse must use raw DIDL, not the library's parsed `Track[]` — the parser
  percent-decodes `res` (`%3a` → `:`), which Sonos then rejects with UPnP 402.
- A container must be enqueued with `AddURIToQueue`, not
  `AddMultipleURIsToQueue` — the latter only accepts individual track URIs.
- The container's own `r:resMD` must be passed through **still XML-encoded**. It
  carries the `<desc id="cdudn">SA_RINCON…-Token</desc>` service token; without
  it Sonos returns UPnP 800, and decoding it returns UPnP 402.

Also found: Sonos playlists (`SQ:`) browse straight into individual track URIs
with no expansion at all, so the most common case never needs the scratch queue.

**Spike this before anything else is built on it (M3).** If a source can't be expanded, the UI marks it *container-only*: it can still play whole under Sonos' native shuffle, it just can't be cross-shuffled with other sources.

Scratch-queue safety: prefer a player that is idle **and** has an empty queue; otherwise `SaveQueue` → expand → clear → restore → delete the temp playlist. The utility zone is configurable in settings.

### Preset model
Per preset: name, icon, colour; zones with per-zone volume; ordered sources; and toggles for **repeat-all**, **dedupe across sources**, `pauseOthers`, crossfade, HomeKit. No track cap — the whole pool gets enqueued. Order is **reshuffled on every activation** (seeded per activation, not stored).

A preset may instead be a **single non-shufflable stream** — a radio favourite, TV, or line-in. The editor allows a stream as a solo source and blocks mixing it with track sources; activation just does `SetAVTransportURI` with no queue.

### Activation engine (`server/presets/activate.ts`)
1. **Idempotence check** — if this preset is already active, no-op and return success (webhook retries and a repeated Siri "on" must be safe). An explicit *Restart* action reshuffles.
2. Resolve sources from cache → track pool; dedupe if enabled.
3. Seeded Fisher–Yates shuffle across the whole pool.
4. If `pauseOthers`, pause every other coordinator.
5. Standalone the coordinator, join the member zones, **wait for `ZoneGroupTopology` to settle** — grouping is eventually consistent, and volumes set too early get clobbered.
6. Per-zone volume + unmute; play mode `NORMAL` (already shuffled) or `REPEAT_ALL`; crossfade.
7. **Fast start**: clear the queue, `AddMultipleURIsToQueue` the first ~20 tracks (~16 URIs per SOAP call), `SetAVTransportURI(x-rincon-queue:<uuid>#0)`, `Play` — then append the remainder in the background. Without this a large preset is 3–10 seconds of silence after a button press, and HomeKit times out.
8. **Missing speakers**: activate with whatever responded and attach a warning to the activation, surfaced in the API response and the UI. A flaky speaker shouldn't kill the preset.
9. Write an `activation` row: preset id, coordinator, members, the (growing) set of enqueued URIs, warnings, started-at.

Default is grab only the named zones and leave the rest of the house alone; `pauseOthers` is opt-in per preset.

**Stop** = pause the coordinator and clear the activation. Speakers stay grouped, volumes stay put, the queue stays loaded, so you can carry on in the Sonos app.

### Active-state detection ("loose")
A preset is ON iff a live activation exists **and** the coordinator is `PLAYING` **and** its group still contains the preset's zones **and** the current track URI is in that activation's URI set. Recomputed on every AVTransport/topology event; drives the HomeKit `On` characteristic and the UI badge. Survives skips, volume changes and an extra speaker joining; goes OFF on pause/stop or when the queue is replaced. Activating a preset invalidates any live activation sharing its zones.

### Pause All Music (leaves TV audio alone)
Pause every group playing **music**, skipping any coordinator whose transport URI is a home-theatre stream (`x-sonos-htastream:…`) — so the TV/soundbar keeps playing. Line-in (`x-rincon-stream:`) is skipped by the same configurable rule. Invalidates any activations it silences, so those switches go off too.

One `pauseAllMusic()` service, three entry points: a UI header button, a webhook with a reserved system token, and a HomeKit switch.

### HomeKit (`server/homekit/`) — optional, off by default
Embedded `@homebridge/hap-nodejs`, **no Homebridge required**. Gated behind `DOMOVOI_HOMEKIT=1`: when unset the module is never imported and nothing is advertised over mDNS. Everything else works unchanged.

When enabled: one `Switch` per preset with `homekit: true` (on → activate, off → stop, state → the active-state computation), plus a **Pause All Music** switch. That one is momentary — it reports OFF and auto-resets ~1s after being flipped on, since "is all music paused" isn't a meaningful persistent state. Pairing code + QR in Settings; HAP state in `/data/hap`.

### API (`server/routes/`)
- `GET /api/system` snapshot; `GET /api/events` WebSocket diffs.
- `POST /api/zones/:id/{play,pause,next,previous,seek,volume,mute}`; `POST /api/groups/{join,leave}`.
- `GET/POST/PATCH/DELETE /api/presets`; `POST /api/presets/:id/{activate,stop,restart}`; `GET /api/presets/export`.
- `GET /api/sources/browse?path=` (favourites / playlists / library); `POST /api/sources/resolve` — paste a URL, preview the track list before saving.
- `POST /api/pause-all`.
- `GET|POST /api/webhooks/:token` — per-preset tokens plus a reserved pause-all token; regenerable; GET supported so Shortcuts / Stream Deck / Node-RED can fire them. Not session-gated. Responds immediately; activation runs async.
- `GET /api/art?…` — proxies speaker `:1400/getaa` artwork so it works off-LAN behind Tailscale or a reverse proxy.

### Auth
Single shared password (`DOMOVOI_PASSWORD`), argon2-hashed at boot, httpOnly signed session cookie, Fastify preHandler on everything except login and `/api/webhooks/*`. Host-header allowlist to blunt DNS rebinding.

### Data model (Drizzle, SQLite at `/data/domovoi.db`)
`presets` · `preset_zones` (preset_id, zone_id, volume, is_coordinator) · `preset_sources` (preset_id, position, kind, ref, label) · `resolved_tracks` cache (source hash, uris JSON, resolved_at) · `activations` · `settings`. A **`triggers` table exists from day one** so cron schedules drop in later without migration — no scheduler in v1.

## UI (shadcn, mobile-first, dark mode)
Transport only — starting *content* always goes through a preset.

- `/` **Now Playing** — a card per group: artwork, transport, seek, per-zone volume sliders, drag-to-group / ungroup. Pause All Music in the header.
- `/presets` — grid of large activate buttons showing live active state; editor sheet with name, icon/colour, zone picker with per-zone volumes, source list (browse *or* paste URL) showing resolved track counts, repeat-all / dedupe / `pauseOthers` / crossfade toggles, HomeKit toggle, copyable webhook URL.
- `/settings` — password, HomeKit pairing, discovery seed IP, utility zone, cache controls, logs.

## Packaging & deploy
Mirrors `~/Developer/euroscores`: `compose.yml` (Unraid paths under `/mnt/user/appdata/domovoi`, `network_mode: host`), `compose.local.yml` for dev, a `justfile`, and `scripts/deploy-unraid` that rsyncs sources to `root@unraid.jsp.scot:/mnt/user/appdata/domovoi_source`, builds remotely and `docker compose up -d`. Nothing Unraid-specific in the image itself — a plain `docker run --network host -v ./data:/data ghcr.io/…/domovoi` works anywhere.

`just` recipes: `dev`, `test`, `lint`, `build`, `docker-dev`, `deploy-unraid`.

## Milestones
- **M0** monorepo, Dockerfile, compose, justfile, CI, shadcn baseline.
- **M1** discovery + subscriptions + reconciliation + `SystemState` + WebSocket → read-only Now Playing.
- **M2** transport, volume, grouping control; art proxy.
- **M3** ⚠️ source browsing **+ the URL-expansion spike (SMAPI, then scratch queue)**. Gate M4 on this.
- **M4** preset schema, resolver cache, activation engine with fast start, unit tests.
- **M5** preset UI + editor.
- **M6** webhooks, active-state computation, stop/restart, Pause All Music.
- **M7** embedded HomeKit bridge behind `DOMOVOI_HOMEKIT=1`.
- **M8** auth, GHCR multi-arch image, deploy script, README.

## Risks
1. **Service URL expansion** (M3) — the one genuinely unknown piece. Two approaches to try, plus a container-only fallback, and it's proven before anything depends on it.
2. **Docker networking** — host mode is mandatory; documented, with the seed-IP fallback. Note Docker Desktop on macOS lacks it, so dev runs natively via `just dev`.
3. **Sonos deprecations** — UPnP is on by default in 2026 but Sonos keeps trimming local features. Contained behind our own interface.
4. **Grouping/volume races** — handled by waiting for topology to settle, but this is the classic source of flaky presets; worth explicit tests.
5. **Scratch-queue expansion disturbing a player** — idle-and-empty preferred, `SaveQueue` snapshot/restore otherwise, configurable utility zone.

## Verification
- `just test` — resolver, dedupe, shuffle determinism, and the active-state machine against a faked Sonos layer.
- `just dev` on the LAN: discover zones, confirm Now Playing tracks the Sonos app live; group/ungroup/volume from Domovoi and watch the Sonos app follow.
- Build a preset from two Sonos playlists + one pasted Spotify URL. Activate: verify grouping and volumes, that **sound starts within ~1s**, that the queue is interleaved across all three sources rather than sequential, and that the rest of the pool appears behind it.
- Fire the same webhook twice — second call is a no-op, music doesn't restart. Then *Restart* and confirm a different shuffle order.
- Unplug/deny one speaker in a preset — the rest still play and a warning surfaces.
- Pause in the Sonos app → UI badge and HomeKit switch both go off within a couple of seconds.
- Music in two rooms **and** the TV on the soundbar → Pause All Music from UI, webhook and HomeKit: music stops, TV audio keeps playing.
- Run once with `DOMOVOI_HOMEKIT` unset (nothing on mDNS, everything else works), then set: pair in the Home app, toggle a preset switch both ways, confirm state after activating that preset from the web UI instead.
- `just deploy-unraid`, then the full flow against the Unraid instance with a clean `/data` volume.
