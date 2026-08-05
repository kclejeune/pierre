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

WORKDIR /repo
COPY . .
# moon resolves the workspace's default branch (main) and, in CI mode, HEAD~1.
# Give the throwaway repo two commits so both revisions always exist.
RUN git init -q -b main \
  && git -c user.email=docker@build -c user.name=docker commit -qm base --allow-empty \
  && git add -A \
  && git -c user.email=docker@build -c user.name=docker commit -qm build-context

RUN pnpm install --frozen-lockfile

# Build-time configuration. The home page is statically prerendered during
# `next build`, so the GitHub instance settings (and the public OAuth client
# id) must be present now — runtime-only values would leave stale defaults
# baked into static pages. The client SECRET is deliberately not a build arg:
# it is runtime-only and never enters image layers.
ARG DIFFSHUB_GITHUB_URL
ARG DIFFSHUB_GITHUB_API_URL
ARG DIFFSHUB_GITHUB_RAW_URL
ARG DIFFSHUB_GITHUB_CLIENT_ID
ARG DIFFSHUB_PUBLIC_ORIGIN
ENV DIFFSHUB_GITHUB_URL=$DIFFSHUB_GITHUB_URL \
    DIFFSHUB_GITHUB_API_URL=$DIFFSHUB_GITHUB_API_URL \
    DIFFSHUB_GITHUB_RAW_URL=$DIFFSHUB_GITHUB_RAW_URL \
    DIFFSHUB_GITHUB_CLIENT_ID=$DIFFSHUB_GITHUB_CLIENT_ID \
    DIFFSHUB_PUBLIC_ORIGIN=$DIFFSHUB_PUBLIC_ORIGIN

ENV NEXT_OUTPUT=standalone
RUN pnpm exec moon run diffshub:build

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

USER node
EXPOSE 3000
CMD ["node", "apps/diffshub/server.js"]
