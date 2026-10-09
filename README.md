# Slipmat

Self-hosted web app for controlling and automating a Sonos system on the local network.

The point of Slipmat is **presets**: named automations that group a set of speakers, set their
volumes, and start playback of a track pool shuffled together from several playlists, albums and
favourites. Presets can be fired from the UI, from a webhook, or from a HomeKit switch that also
reports whether the preset is currently playing.

It talks to Sonos entirely over the local network — no cloud, no Sonos account.

> **Status:** early. See [`docs/PLAN.md`](docs/PLAN.md) for the full design and milestones.

## Features

- Web UI for everyday playback: play/pause/skip/seek, per-zone volume, group and ungroup.
- Presets that group speakers, set per-zone volumes, and play a shuffled cross-source track pool.
- Sources: Sonos playlists, Sonos favourites, the local music library, and streaming content you
  paste a share URL for.
- Triggers: UI buttons, webhooks (GET or POST, so Shortcuts and Stream Deck work), and an optional
  embedded HomeKit bridge.
- **Pause All Music** — silences the house without touching TV audio.

## Running it

### Unraid

Install **Slipmat** from Community Applications. Until it's listed there, fetch the template on the
server and pick it from **Docker → Add Container → Template**:

```sh
wget -O /boot/config/plugins/dockerMan/templates-user/my-Slipmat.xml \
  https://raw.githubusercontent.com/alexjsp/slipmat/main/unraid/slipmat.xml
```

### Docker Compose

```sh
curl -O https://raw.githubusercontent.com/alexjsp/slipmat/main/compose.yml
docker compose up -d
```

Settings go in a `.env` beside it; every one is optional.

### Docker

```sh
docker run -d --name slipmat \
  --network host \
  -v /path/to/appdata/slipmat:/data \
  ghcr.io/alexjsp/slipmat:latest
```

Then open `http://<host>:5544`.

### `--network host` is required

Not a convenience — three things depend on it:

- **SSDP discovery** is multicast and doesn't cross a Docker bridge network.
- **UPnP events**: the speakers dial *back into* Slipmat's callback URL, so they need a routable
  address for it.
- **HomeKit** (if enabled) advertises over mDNS.

If discovery still can't get through, set `SLIPMAT_SEED_IP` to any one speaker's IP address —
Slipmat finds the rest of the household from there.

Docker Desktop on macOS has no real host networking. Develop natively with `just dev` instead.

### Configuration

See [`.env.example`](.env.example) for the full list. The ones that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `SLIPMAT_PASSWORD` | — | **Optional.** Setting it turns authentication on; unset means no login. |
| `SLIPMAT_SESSION_SECRET` | generated | Signs login sessions. Generated and stored on first run if unset. |
| `SLIPMAT_PORT` | `5544` | |
| `SLIPMAT_SEED_IP` | — | Discovery fallback. |
| `SLIPMAT_HOMEKIT` | `0` | Set to `1` to enable the embedded HomeKit bridge. |
| `SLIPMAT_HOMEKIT_PIN` | generated | Pairing code. Generated on first run if unset, and shown in Settings. |
| `PUID` / `PGID` | `10001` | User and group the server runs as. `/data` is handed to them on start. |

### Authentication is optional

Slipmat runs without a login by default, and that's deliberate rather than an oversight: Sonos has
no authentication of its own, so anything already on your network can control the speakers. Putting
a password in front of Slipmat wouldn't change that.

Set `SLIPMAT_PASSWORD` to turn it on. Worth doing if you expose Slipmat beyond the LAN, or if not
everyone in the house should be able to edit presets.

Two protections apply either way:

- **Webhook URLs always carry a per-preset secret token** rather than relying on a session, so they
  work from Shortcuts, Node-RED and the like. Regenerate a token from the preset editor if one leaks.
- **A host-header allowlist** blocks DNS rebinding, which is the one thing a browser on your network
  can do to an open LAN service.

## Development

Requires Node 22+, [pnpm](https://pnpm.io) and [just](https://github.com/casey/just).

```sh
just install
just dev        # API on :5544, UI on :5545 with a proxy to the API
just check      # lint, typecheck, test
```

> ⚠️ **Tests never touch real speakers.** They run against the fake Sonos layer. Anything that
> would mutate real hardware needs an explicit ask first — see [`CLAUDE.md`](CLAUDE.md).

Personal recipes, such as a deploy to your own server, can go in a gitignored
`local/local.just`; the justfile imports it when it exists.

## Prior art

[`jishi/node-sonos-http-api`](https://github.com/jishi/node-sonos-http-api) pioneered this shape and
its preset semantics were a useful reference. Slipmat is built on
[`@svrooij/sonos`](https://github.com/svrooij/node-sonos-ts) instead — actively maintained, fully
typed, with the event subscriptions the preset state tracking needs.

## License

[MIT](LICENSE)
