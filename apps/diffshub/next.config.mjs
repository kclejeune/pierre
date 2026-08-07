import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

import { loadWorktreeEnv } from '../../scripts/load-worktree-env.mjs';

// No-op outside `next dev`; in dev it proxies Cloudflare bindings so code
// paths that will run on Workers can be exercised locally.
void initOpenNextCloudflareForDev();

// `next dev` runs under Node, which (like Bun) only auto-loads the standard
// `.env*` names. Our worktree helper writes `PIERRE_WORKTREE_SLUG` /
// `PIERRE_PORT_OFFSET` into `.env.worktree` at the worktree root, so pull
// those in manually before Next inspects `process.env`. moon tasks load the
// same file via their envFile option; the loader preserves existing values.
loadWorktreeEnv();

// The browser title prefix (see `app/layout.tsx`) reads
// `NEXT_PUBLIC_WORKTREE_SLUG` so the value survives into the client bundle.
// Bridge it from the non-prefixed worktree slug so `.env.worktree` stays the
// single source of truth.
if (
  process.env.PIERRE_WORKTREE_SLUG &&
  !process.env.NEXT_PUBLIC_WORKTREE_SLUG
) {
  process.env.NEXT_PUBLIC_WORKTREE_SLUG = process.env.PIERRE_WORKTREE_SLUG;
}

// Opt-in standalone output for container builds (see Dockerfile): bundles the
// server plus traced node_modules under .next/standalone so the runtime image
// needs no pnpm install. Gated behind an env flag so the Vercel deployment
// keeps Next's default output. outputFileTracingRoot points at the monorepo
// root so workspace packages are traced into the bundle correctly.
const standaloneOutput =
  process.env.NEXT_OUTPUT === 'standalone'
    ? {
        output: 'standalone',
        outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
      }
    : {};

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...standaloneOutput,
  // Strict mode is disabled here to avoid GitHub request thrash in dev: the
  // viewer fires upstream patch fetches on mount, and double-invoked effects
  // would double those requests.
  reactStrictMode: false,
  reactCompiler: true,
  devIndicators: false,
  experimental: {
    cssChunking: 'strict',
  },
  // Resolve and transpile workspace packages so subpath exports (e.g. @pierre/trees/react)
  // resolve correctly when Next follows client-component imports from the server.
  transpilePackages: ['@pierre/trees', '@pierre/diffs'],
};

export default nextConfig;
