import {
  defineCloudflareConfig,
  type OpenNextConfig,
} from '@opennextjs/cloudflare';

// Minimal adapter config: the app is almost entirely dynamic (PR and browse
// views render per-request), so there is no incremental cache override yet.
// When ISR/prerender caching becomes worthwhile, bind an R2 bucket as
// NEXT_INC_CACHE_R2_BUCKET in wrangler.toml and pass the
// r2-incremental-cache override here.
const config: OpenNextConfig = {
  ...defineCloudflareConfig({}),
  // OpenNext defaults to `pnpm build`, but package.json scripts are npm
  // lifecycle hooks only in this repo (moon owns tasks). OpenNext exports
  // NEXT_PRIVATE_STANDALONE before running this, so the standalone output it
  // needs is produced without touching the Vercel-facing next.config.
  buildCommand: 'pnpm exec next build',
};

export default config;
