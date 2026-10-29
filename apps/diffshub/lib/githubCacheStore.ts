// Storage and limits for the GitHub read cache (lib/githubReadCache). It
// reuses the preferences backend rather than adding infrastructure:
//
//   - Redis/Valkey (DIFFSHUB_REDIS_URL): entries expire by TTL, and a Lua
//     script enforces a total byte budget and entry cap atomically on every
//     write. The budget is tracked on the cache's own index keys, so eviction
//     never touches preference keys sharing the server.
//   - Workers KV (the DIFFSHUB_PREFERENCES binding): entries expire by TTL
//     (KV's minimum is 60 seconds). KV has no atomic counters, so the total
//     budget is not enforced there; the TTL and per-entry cap bound it.
//
// Every key lives under the `{ghcache}` hash tag, so on a Redis Cluster the
// script's keys share one slot.

import { createHash } from 'node:crypto';

import { parseDurationSeconds } from './githubEnvironment';
import { readNonEmptyString } from './githubOAuthGrant';
import {
  getRedisConnection,
  type PreferenceStore,
  readCloudflareKVBinding,
} from './preferenceStore';

export const CACHE_KEY_PREFIX = '{ghcache}:v1:';
const INDEX_KEY = '{ghcache}:index';
const SIZES_KEY = '{ghcache}:sizes';
const BYTES_KEY = '{ghcache}:bytes';
const KV_MIN_TTL_SECONDS = 60;

export interface GitHubCacheLimits {
  // Largest single value written; bigger values are simply not cached.
  maxEntryBytes: number;
  // Total stored bytes and entry count (enforced on Redis only).
  maxBytes: number;
  maxEntries: number;
  ttlSeconds: number;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, limits: GitHubCacheLimits): Promise<void>;
}

const DEFAULT_LIMITS: GitHubCacheLimits = {
  maxBytes: 1024 * 1024 * 1024,
  maxEntries: 100_000,
  maxEntryBytes: 1024 * 1024,
  ttlSeconds: 86_400,
};

// The configured limits, or null when caching is turned off
// (DIFFSHUB_GITHUB_CACHE_TTL=0). Memoized: the values are fixed for the
// process, and a malformed value throws at the first read (and in the health
// check) rather than per request.
let cachedLimits: { limits: GitHubCacheLimits | null } | undefined;

export function getGitHubCacheLimits(): GitHubCacheLimits | null {
  cachedLimits ??= { limits: readGitHubCacheLimits() };
  return cachedLimits.limits;
}

export function readGitHubCacheLimits(): GitHubCacheLimits | null {
  const ttlSeconds =
    parseDurationSeconds(
      process.env.DIFFSHUB_GITHUB_CACHE_TTL,
      'DIFFSHUB_GITHUB_CACHE_TTL'
    ) ?? DEFAULT_LIMITS.ttlSeconds;
  if (ttlSeconds === 0) {
    return null;
  }
  const maxBytes =
    parseByteSize('DIFFSHUB_GITHUB_CACHE_MAX_BYTES') ?? DEFAULT_LIMITS.maxBytes;
  const maxEntryBytes = Math.min(
    parseByteSize('DIFFSHUB_GITHUB_CACHE_MAX_ENTRY_BYTES') ??
      DEFAULT_LIMITS.maxEntryBytes,
    maxBytes
  );
  const maxEntriesText = readNonEmptyString(
    process.env.DIFFSHUB_GITHUB_CACHE_MAX_ENTRIES
  );
  const maxEntries =
    maxEntriesText == null ? DEFAULT_LIMITS.maxEntries : Number(maxEntriesText);
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error(
      `DIFFSHUB_GITHUB_CACHE_MAX_ENTRIES must be a positive integer: ${maxEntriesText}`
    );
  }
  return { maxBytes, maxEntries, maxEntryBytes, ttlSeconds };
}

// A byte count with an optional binary suffix: `1048576`, `512k`, `256m`, `1g`.
function parseByteSize(name: string): number | undefined {
  const text = readNonEmptyString(process.env[name]);
  if (text == null) {
    return undefined;
  }
  const match = /^(\d+)([kmg])?i?b?$/.exec(text.trim().toLowerCase());
  const multipliers: Record<string, number> = {
    g: 1024 ** 3,
    k: 1024,
    m: 1024 ** 2,
  };
  const bytes =
    match == null
      ? Number.NaN
      : Number(match[1]) * (match[2] == null ? 1 : multipliers[match[2]]);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(
      `${name} must be a size like 1048576, 512k, or 256m: ${text}`
    );
  }
  return bytes;
}

// Health checks and the startup banner call this so a malformed cache setting
// keeps the instance out of service.
export function validateGitHubCacheConfiguration(): void {
  getGitHubCacheLimits();
}

export async function getGitHubCacheStore(): Promise<CacheStore | undefined> {
  const connection = getRedisConnection();
  if (connection != null) {
    const { run } = await connection;
    return {
      get: (key) => run((client) => client.get(key)),
      async put(key, value, limits) {
        const options = {
          arguments: [
            value,
            String(limits.ttlSeconds),
            String(Date.now()),
            String(limits.maxBytes),
            String(limits.maxEntries),
          ],
          keys: [INDEX_KEY, SIZES_KEY, BYTES_KEY, key],
        };
        // Runs the server's cached copy of the script by SHA, and uploads
        // the script only when the server does not have it yet (first write,
        // or after a restart or SCRIPT FLUSH).
        await run((client) =>
          client
            .evalSha(redisCachePutSha(), options)
            .catch((error: unknown) => {
              if (!String(error).includes('NOSCRIPT')) {
                throw error;
              }
              return client.eval(REDIS_CACHE_PUT_SCRIPT, options);
            })
        );
      },
    };
  }
  const kv = await readCloudflareKVBinding();
  return kv == null ? undefined : kvCacheStore(kv);
}

// Entries expire by TTL, clamped to the minimum Workers KV accepts.
function kvCacheStore(kv: PreferenceStore): CacheStore {
  return {
    get: (key) => kv.get(key),
    put: (key, value, limits) =>
      kv.put(key, value, {
        expirationTtl: Math.max(KV_MIN_TTL_SECONDS, limits.ttlSeconds),
      }),
  };
}

// Writes one entry and enforces the budget in a single atomic step.
//   KEYS: index zset (entry key -> expiry ms), sizes hash (entry key ->
//         bytes), total-bytes counter, the entry key.
//   ARGV: value, ttl seconds, now ms, max total bytes, max entries.
// Expired index members are pruned first (a bounded batch per write), the
// entry is (re)written, and then the soonest-expiring entries are evicted
// until both limits hold. Every TTL is the same, so soonest-expiring is
// oldest-written.
const REDIS_CACHE_PUT_SCRIPT = `
local function evict(key)
  local size = redis.call('HGET', KEYS[2], key)
  if size then
    redis.call('DECRBY', KEYS[3], size)
    redis.call('HDEL', KEYS[2], key)
  end
  redis.call('ZREM', KEYS[1], key)
  redis.call('DEL', key)
end
local now = tonumber(ARGV[3])
for _, key in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 100)) do
  evict(key)
end
evict(KEYS[4])
local size = string.len(ARGV[1])
redis.call('SET', KEYS[4], ARGV[1], 'EX', ARGV[2])
redis.call('HSET', KEYS[2], KEYS[4], size)
redis.call('INCRBY', KEYS[3], size)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]) * 1000, KEYS[4])
local maxBytes = tonumber(ARGV[4])
local maxEntries = tonumber(ARGV[5])
while tonumber(redis.call('GET', KEYS[3]) or '0') > maxBytes
  or redis.call('ZCARD', KEYS[1]) > maxEntries do
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0)
  if #oldest == 0 then break end
  evict(oldest[1])
end
return 1
`;

let cachedPutSha: string | undefined;

function redisCachePutSha(): string {
  cachedPutSha ??= createHash('sha1')
    .update(REDIS_CACHE_PUT_SCRIPT)
    .digest('hex');
  return cachedPutSha;
}
