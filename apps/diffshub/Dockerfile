# syntax=docker/dockerfile:1
# Multi-stage build for self-hosting DiffsHub. Build context must be the
# monorepo root (the app depends on workspace packages); the repo-root
# docker-compose.yml wires that up so `docker compose up --build` works from
# there.
#
# DiffsHub is not a static site — /api/diff, /api/github-diff-file, and the
# OAuth routes are server-side — so the runtime is Next's standalone Node
# server rather than nginx.

# Node pin mirrors .prototools. Debian (not alpine): moon bootstraps the
# pinned toolchain from .prototools through proto, and the pinned bun ships
# glibc binaries that cannot run on musl.
FROM node:24.11.0-slim AS builder

# moon hashes task inputs through git, over a throwaway repo created below
# (the real .git is excluded via .dockerignore).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# pnpm pin mirrors .prototools.
RUN npm install -g pnpm@11.9.0

# Keep pnpm's content-addressable store on a BuildKit cache mount so package
# tarballs survive rebuilds even after the layers below are invalidated.
ENV npm_config_store_dir=/pnpm/store

WORKDIR /repo

# Populate the store from the lockfile alone (pnpm fetch exists for exactly
# this), before the source tree enters the image: source-only changes reuse
# this layer, and the install below just links offline from the store.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
# moon resolves the workspace's default branch (main) and, in CI mode, HEAD~1.
# Give the throwaway repo two commits so both revisions always exist.
RUN git init -q -b main \
  && git -c user.email=docker@build -c user.name=docker commit -qm base --allow-empty \
  && git add -A \
  && git -c user.email=docker@build -c user.name=docker commit -qm build-context

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline

# No DIFFSHUB_* configuration enters the build: NEXT_OUTPUT=standalone both
# selects standalone output and defers all page rendering to request time
# (see RootLayout), so every setting is read from the runtime environment and
# the image is deployment-agnostic.
ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
# This layer can never cache (it sits below COPY . .), so mount what it
# re-derives: moon bootstraps the pinned bun toolchain into ~/.proto, and
# Next.js keeps its compiler cache in .next/cache. Neither enters the image.
RUN --mount=type=cache,id=proto-tools,target=/root/.proto \
    --mount=type=cache,id=next-cache,target=/repo/apps/diffshub/.next/cache \
    pnpm exec moon run diffshub:build

FROM node:24.11.0-slim AS runner

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# The standalone bundle preserves the monorepo layout, so the server entry
# lives at apps/diffshub/server.js. Static assets and public files are not
# traced into the bundle and are copied alongside it.
COPY --from=builder /repo/apps/diffshub/.next/standalone ./
COPY --from=builder /repo/apps/diffshub/.next/static ./apps/diffshub/.next/static
COPY --from=builder /repo/apps/diffshub/public ./apps/diffshub/public

# The COPYs above are root-owned, but Next writes its incremental fetch cache
# (routes using `next: { revalidate }`, e.g. profile lookups) to .next/cache
# at request time. Pre-create it owned by the runtime user; without this every
# cacheable fetch logs "failed to update prerender cache: EACCES".
RUN mkdir -p apps/diffshub/.next/cache \
  && chown node:node apps/diffshub/.next/cache

USER node
EXPOSE 3000
CMD ["node", "apps/diffshub/server.js"]
