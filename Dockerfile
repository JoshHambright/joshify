# syntax=docker/dockerfile:1.7
#
# Joshify server image — P8-01 / P8-02.
#
# WHAT THIS IMAGE IS
#   The *server* half of Joshify: Spotify I/O, the token store, the polling
#   engine, theme extraction and blur pre-rendering, and the local REST +
#   WebSocket transport the panel talks to (DECISIONS.md D-003).
#
# WHAT THIS IMAGE IS NOT
#   The kiosk. The browser that draws the panel runs natively on the Pi against
#   DRM/KMS, not in here — see docs/INSTALL.md "Why the container is the server
#   only". The built panel bundle rides along at /app/apps/ui/dist-web so a
#   native kiosk can be pointed at it, but nothing in this image draws pixels.
#
# BUILD
#   docker buildx build --platform linux/arm64 -t joshify .
#
# Multi-stage on purpose: pnpm, the TypeScript compiler, Vite, svelte-check and
# every devDependency exist in `build` and reach the final image never.

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.33.0

# --------------------------------------------------------------------------
# base — the toolchain, shared by every build stage.
#
# Debian Bookworm rather than Alpine because the Pi runs Raspberry Pi OS
# Bookworm (D-008): same libc, same OpenSSL lineage, so "works in the container"
# and "works from the install script" fail in the same ways rather than in
# different ones. Alpine would save ~70MB and buy a musl variable we would then
# have to hold in our heads on every debug.
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /app

# --------------------------------------------------------------------------
# manifests — every file that can change the dependency graph, and nothing else.
#
# This layer is what the pnpm installs below cache on. Editing a .ts file must
# not invalidate a dependency install, and here it cannot: source arrives after.
# --------------------------------------------------------------------------
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/ui/package.json apps/ui/

# --------------------------------------------------------------------------
# build — full install (devDependencies included), then the workspace build.
#
# `pnpm build` is the repo's own recursive build: tsc for core and server,
# svelte-check + vite for the panel. Using the repo's script rather than
# reimplementing it means this image cannot drift from what `pnpm verify` in CI
# already proved green.
# --------------------------------------------------------------------------
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm build

# --------------------------------------------------------------------------
# prod-deps — the runtime dependency tree, installed clean rather than pruned.
#
# Two deliberate choices:
#
#   --prod                      drops every devDependency. The runtime needs
#                               fastify, @fastify/websocket and jimp; it does
#                               not need TypeScript, Vite or Vitest.
#
#   --config.node-linker=hoisted  produces a flat, ordinary node_modules instead
#                               of pnpm's symlink farm into .pnpm. A symlinked
#                               store copies across a COPY --from correctly only
#                               if you take the whole tree; hoisted is trivially
#                               copyable and needs no pnpm in the final image.
#
# Installing fresh beats pruning the build stage: the build stage's tree is
# entangled with devDependency hoisting, and a prune that half-works is a defect
# you discover in production.
# --------------------------------------------------------------------------
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod --ignore-scripts \
      --config.node-linker=hoisted

# --------------------------------------------------------------------------
# runtime — node, the runtime deps, the compiled output. Nothing else.
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# Recorded on the image so a Pi three years from now can answer "what is this
# and where did it come from" from `docker inspect` alone.
ARG VERSION=0.0.0-dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Joshify" \
      org.opencontainers.image.description="Touchscreen control surface for Spotify — server half" \
      org.opencontainers.image.source="https://github.com/JoshHambright/joshify" \
      org.opencontainers.image.documentation="https://github.com/JoshHambright/joshify/blob/main/docs/INSTALL.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

# Two ports, because there are two listeners and they are not the same one:
#
#   JOSHIFY_SERVE_PORT  the panel's server (`joshify serve`, default 4770).
#   JOSHIFY_PORT        the loopback callback listener that `joshify auth` opens
#                       for the length of the PKCE exchange. 8080 because that
#                       is the port in the registered redirect URI, and Spotify
#                       matches redirect URIs exactly, port included.
ENV NODE_ENV=production \
    JOSHIFY_DATA_DIR=/data \
    JOSHIFY_HOST=127.0.0.1 \
    JOSHIFY_SERVE_PORT=4770 \
    JOSHIFY_PORT=8080

WORKDIR /app

# The `node` user ships with the base image at uid/gid 1000 — the same uid the
# first user account on a Raspberry Pi OS install gets. That is not a
# coincidence worth ignoring: a bind-mounted data directory owned by the Pi's
# own user is readable and writable in here with no chown dance.
#
# 0700 because this directory holds the encrypted refresh token and, beside it,
# the key that opens it (D-021). The narrow guarantee that design makes is about
# the token travelling *without* the device; wide permissions would give that up
# for free.
RUN install -d -m 0700 -o node -g node /data

# The runtime dependency tree and the manifests that name it.
COPY --from=prod-deps /app /app

# The compiled output, laid over the top.
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/ui/dist-web ./apps/ui/dist-web

USER node

# Documentation, not a firewall. With `network_mode: host` — which the compose
# file uses, and which the PKCE loopback redirect requires — these are inert.
EXPOSE 4770
EXPOSE 8080

# No curl in a slim image, and adding one to answer a healthcheck would be a
# poor trade. Node can ask the question itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.JOSHIFY_SERVE_PORT || '4770') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# ENTRYPOINT is the CLI, so the image serves both roles a first run needs:
#
#   docker compose up -d              -> `serve`
#   docker compose run --rm server auth -> the one-time PKCE flow
#   docker compose run --rm server status
#
# Signals are left to the container runtime's init (`init: true` in compose)
# rather than baking tini in, which would be another package to track for the
# sake of reaping a process tree that has one process in it.
ENTRYPOINT ["node", "apps/server/dist/cli/bin.js"]
CMD ["serve"]
