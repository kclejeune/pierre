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

// Security response headers for the app's own documents and assets.
//
// The GitHub token lives in localStorage (see components/useGitHubToken.ts) and
// carries write access to every repo the viewer can reach, so the point of this
// policy is to shrink what an injected script could do with it: no foreign
// script origins to exfiltrate to, no framing, no <base> rewrite, no plugins.
//
// script-src keeps 'unsafe-inline' deliberately. Next injects inline bootstrap
// and Flight payload scripts into statically prerendered pages, and a
// per-request nonce would force every page dynamic. Inline script therefore
// still runs; what the policy removes is the ability to *load* or *talk to*
// anything off-origin.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // blob: covers the object URLs GitHubAssetImage builds from token-authorized
  // asset fetches; https: keeps third-party README badges and logos rendering,
  // which markdown bodies routinely reference.
  "img-src 'self' blob: data: https:",
  // 'wasm-unsafe-eval' is required by the syntax highlighter: Shiki compiles a
  // WebAssembly regex engine inside the worker pool, and WebAssembly
  // instantiation counts as script evaluation under CSP. This is the narrow
  // form that permits wasm only — plain eval() of a JavaScript string stays
  // blocked, which 'unsafe-eval' would not.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  // Tailwind and the theme controller set inline styles, and Mermaid's
  // rendered SVG carries its own <style> block.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  // Every browser-side fetch is same-origin: the server proxies GitHub, so the
  // instance itself is never contacted from the page.
  "connect-src 'self'",
  "worker-src 'self'",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Redundant with frame-ancestors on current browsers; kept for older ones.
  { key: 'X-Frame-Options', value: 'DENY' },
];

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
  // /api is excluded rather than covered here: those routes set their own
  // headers, and the asset proxies serve untrusted upstream bytes under a much
  // stricter policy (lib/inertAssetResponse.ts). Matching them too would leave
  // every proxied asset with two Content-Security-Policy headers to satisfy.
  headers() {
    return Promise.resolve([
      { source: '/((?!api/).*)', headers: SECURITY_HEADERS },
    ]);
  },
};

export default nextConfig;
