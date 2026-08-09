default:
  @just --list

install:
  pnpm install

# Run server and UI natively. Preferred over Docker for development: SSDP
# discovery and UPnP callbacks need real host networking.
[no-exit-message]
dev: install
  pnpm --filter @domovoi/shared build
  pnpm -r --parallel dev

[no-exit-message]
server:
  pnpm --filter @domovoi/server dev

[no-exit-message]
web:
  pnpm --filter @domovoi/web dev

build:
  pnpm --filter @domovoi/shared build
  pnpm --filter @domovoi/server build
  pnpm --filter @domovoi/web build

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

docker-build:
  docker compose -f compose.local.yml build

docker-dev:
  docker compose -f compose.local.yml up --build

docker-down:
  docker compose -f compose.local.yml down

deploy-unraid:
  ./scripts/deploy-unraid
