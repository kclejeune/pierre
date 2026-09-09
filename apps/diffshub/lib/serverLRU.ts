import { createHash } from 'node:crypto';

interface AsyncLRUOptions<V> {
  maxEntries: number;
  maxWeight?: number;
  ttlMs: number;
  weight?(value: V): number;
}

interface AsyncLRUEntry<V> {
  expiresAt: number;
  promise: Promise<V>;
  weight: number;
}

export interface AsyncLRU<K, V> {
  clear(): void;
  // Drops a key so the next getOrCreate reloads it. Used when a cached value
  // is discovered to be stale by something only the caller can check.
  delete(key: K): void;
  getOrCreate(key: K, create: () => Promise<V>): Promise<V>;
  // Whether an unexpired entry (resolved or still loading) exists, so a caller
  // can tell a cache hit from a fresh load without forcing one.
  has(key: K): boolean;
}

// A bounded process-local cache for server work that is expensive to repeat.
// Pending calls are deduplicated, rejected calls are discarded, and resolved
// values can be limited by an approximate application-provided memory weight.
export function createAsyncLRU<K, V>(
  options: AsyncLRUOptions<V>
): AsyncLRU<K, V> {
  const entries = new Map<K, AsyncLRUEntry<V>>();
  let totalWeight = 0;

  function remove(key: K): void {
    const entry = entries.get(key);
    if (entry != null) {
      totalWeight -= entry.weight;
      entries.delete(key);
    }
  }

  function trim(): void {
    while (
      entries.size > options.maxEntries ||
      (options.maxWeight != null && totalWeight > options.maxWeight)
    ) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey == null) {
        return;
      }
      remove(oldestKey);
    }
  }

  function getOrCreate(key: K, create: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const cached = entries.get(key);
    if (cached != null && cached.expiresAt > now) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.promise;
    }
    if (cached != null) {
      remove(key);
    }

    const pending = Promise.resolve().then(create);
    // A pending load does not expire. Its freshness window begins when the
    // value resolves, so a slow upstream request remains deduplicated rather
    // than spawning another copy after ttlMs.
    const entry: AsyncLRUEntry<V> = {
      expiresAt: Number.POSITIVE_INFINITY,
      promise: pending,
      weight: 0,
    };
    const promise = pending.then(
      (value) => {
        if (entries.get(key) === entry) {
          const measured = options.weight?.(value) ?? 1;
          entry.weight = Number.isFinite(measured) ? Math.max(0, measured) : 0;
          entry.expiresAt = Date.now() + options.ttlMs;
          totalWeight += entry.weight;
          trim();
        }
        return value;
      },
      (error: unknown) => {
        if (entries.get(key) === entry) {
          remove(key);
        }
        throw error;
      }
    );
    entry.promise = promise;
    entries.set(key, entry);
    trim();
    return promise;
  }

  return {
    clear() {
      entries.clear();
      totalWeight = 0;
    },
    delete: remove,
    getOrCreate,
    has(key: K): boolean {
      const entry = entries.get(key);
      return entry != null && entry.expiresAt > Date.now();
    },
  };
}

// Tokens must influence cache identity without becoming long-lived Map keys or
// appearing in diagnostics. The digest is only an in-process partition key.
export function credentialCacheScope(token: string | undefined): string {
  return token == null || token === ''
    ? 'anonymous'
    : createHash('sha256').update(token).digest('base64url');
}
