# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- dependencies -----------------------------------------------------------
# better-sqlite3 and argon2 are native modules, so the build stage needs a
# toolchain. The runtime stage gets only the compiled output.
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm --filter @domovoi/shared build \
  && pnpm --filter @domovoi/server build \
  && pnpm --filter @domovoi/web build

# Prune to production dependencies for the runtime image. --legacy because
# @domovoi/shared is a plain workspace link rather than an injected dependency;
# pnpm 10 otherwise refuses to deploy.
RUN pnpm --filter @domovoi/server --prod deploy --legacy /tmp/server

# ---- runtime ----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ARG DOMOVOI_VERSION=dev
ENV NODE_ENV=production
ENV DOMOVOI_DATA_DIR=/data
ENV DOMOVOI_VERSION=${DOMOVOI_VERSION}
WORKDIR /app

RUN useradd --system --uid 10001 --create-home domovoi \
  && mkdir -p /data && chown domovoi:domovoi /data

COPY --from=build --chown=domovoi:domovoi /tmp/server/node_modules ./node_modules
COPY --from=build --chown=domovoi:domovoi /app/packages/server/dist ./dist
COPY --from=build --chown=domovoi:domovoi /app/packages/web/dist ./public

USER domovoi
VOLUME ["/data"]
EXPOSE 5544

# No curl in the image; use node's own fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DOMOVOI_PORT||5544)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
