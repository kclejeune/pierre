// /api/github-pulls pages a token searched recently, keyed by its
// credential scope and the request's query string. Younger than
// PULLS_PAGE_CACHE_FRESH_MS, a page answers as is; up to
// PULLS_PAGE_CACHE_STALE_MS it still answers at once, flagged stale, so a
// reload or a return to a filter paints right away while the client fetches
// the current page behind it. Lives outside the route file because Next.js
// route modules may only export their handlers.

import { createAsyncLRU } from './serverLRU';

export const PULLS_PAGE_CACHE_FRESH_MS = 15_000;
const PULLS_PAGE_CACHE_STALE_MS = 120_000;

export const pullsPageCache = createAsyncLRU<
  string,
  { body: Record<string, unknown>; storedAt: number }
>({ maxEntries: 500, ttlMs: PULLS_PAGE_CACHE_STALE_MS });
