default:
  @just --list

install:
  pnpm install

# Run server and UI natively. Preferred over Docker for development: SSDP
# discovery and UPnP callbacks need real host networking.
[no-exit-message]
dev: install
  pnpm --filter @slipmat/shared build
  pnpm -r --parallel dev

[no-exit-message]
server:
  pnpm --filter @slipmat/server dev

[no-exit-message]
web:
  pnpm --filter @slipmat/web dev

build:
  pnpm --filter @slipmat/shared build
  pnpm --filter @slipmat/server build
  pnpm --filter @slipmat/web build
  # The server serves the SPA from its own `public/`, which the Dockerfile
  # populates. Locally nothing did, so a stale copy could sit there for hours
  # serving a UI that no longer matched the source — including, memorably, the
  # old app name after a rename.
  rm -rf packages/server/public
  cp -R packages/web/dist packages/server/public

# Tests run against the fake Sonos layer only — never a real household.
test:
  pnpm -r test

typecheck:
  pnpm -r typecheck

lint:
  pnpm exec biome check .

format:
  pnpm exec biome check --write .

check: lint typecheck test

# Screenshot the UI against the fake household (no real speakers touched).
screenshot route="/" output="screenshot.png" width="430" height="900":
  ./scripts/screenshot {{route}} {{output}} {{width}} {{height}}

# Capture the whole UI (interactive surfaces included) via Playwright.
screenshots output="screenshots":
  ./scripts/screenshots {{output}}

docker-build:
  docker compose -f compose.local.yml build

docker-dev:
  docker compose -f compose.local.yml up --build

docker-down:
  docker compose -f compose.local.yml down

# Personal, gitignored recipes (deploy targets and the like) live here.
import? 'local/local.just'
