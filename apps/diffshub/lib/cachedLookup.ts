import { useEffect, useState } from 'react';

export interface CachedLookup<K, V> {
  // Starts (or joins) the fetch for a key. Concurrent callers share one
  // in-flight promise; settled results, including null failures, use the
  // bounded TTL cache configured below.
  load(key: K): Promise<V | null>;
  // Subscribes a component to a key's value. Resolved keys render
  // synchronously from the cache; unresolved keys return null until the fetch
  // settles. Pass null to skip the lookup entirely.
  useValue(key: K | null): V | null;
}

interface CachedLookupOptions {
  failureTTL?: number;
  maxEntries?: number;
  valueTTL?: number;
}

interface ResolvedEntry<V> {
  expiresAt: number;
  value: V | null;
}

// Builds a module-level fetch cache shared by every mount of a hook: one
// request per key instead of one per component. Short failure caching prevents
// request storms without pinning a transient failure for the whole session.
// Backs hooks like
// useGitHubUser and useGitHubUserName, which need late-mounting consumers
// (e.g. thread cards scrolled into view) to render cached values
// synchronously.
export function createCachedLookup<K, V>(
  fetcher: (key: K) => Promise<V | null>,
  options: CachedLookupOptions = {}
): CachedLookup<K, V> {
  const pendingByKey = new Map<K, Promise<V | null>>();
  const resolvedByKey = new Map<K, ResolvedEntry<V>>();

  function readResolved(key: K): V | null | undefined {
    const entry = resolvedByKey.get(key);
    if (entry == null) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      resolvedByKey.delete(key);
      return undefined;
    }
    resolvedByKey.delete(key);
    resolvedByKey.set(key, entry);
    return entry.value;
  }

  function trimResolved(): void {
    const maxEntries = options.maxEntries ?? 256;
    while (resolvedByKey.size > maxEntries) {
      const oldestKey = resolvedByKey.keys().next().value;
      if (oldestKey == null) {
        break;
      }
      resolvedByKey.delete(oldestKey);
    }
  }

  function load(key: K): Promise<V | null> {
    const resolved = readResolved(key);
    if (resolved !== undefined) {
      return Promise.resolve(resolved);
    }
    let pending = pendingByKey.get(key);
    if (pending == null) {
      pending = fetcher(key).catch(() => null);
      void pending.then((value) => {
        pendingByKey.delete(key);
        resolvedByKey.set(key, {
          expiresAt:
            Date.now() +
            (value == null
              ? (options.failureTTL ?? 30_000)
              : (options.valueTTL ?? 5 * 60_000)),
          value,
        });
        trimResolved();
      });
      pendingByKey.set(key, pending);
    }
    return pending;
  }

  function useValue(key: K | null): V | null {
    const [state, setState] = useState<{ key: K | null; value: V | null }>(
      () => ({ key, value: key == null ? null : (readResolved(key) ?? null) })
    );

    useEffect(() => {
      if (key == null) {
        return;
      }
      let cancelled = false;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;

      const refresh = () => {
        void load(key).then((resolvedValue) => {
          if (cancelled) {
            return;
          }
          setState({ key, value: resolvedValue });
          const expiresAt = resolvedByKey.get(key)?.expiresAt;
          const ttl =
            resolvedValue == null
              ? (options.failureTTL ?? 30_000)
              : (options.valueTTL ?? 5 * 60_000);
          refreshTimer = setTimeout(
            refresh,
            Math.max(1, (expiresAt ?? Date.now() + ttl) - Date.now())
          );
        });
      };

      refresh();
      return () => {
        cancelled = true;
        if (refreshTimer != null) {
          clearTimeout(refreshTimer);
        }
      };
    }, [key]);

    if (key == null) {
      return null;
    }
    const resolved = readResolved(key);
    if (resolved !== undefined) {
      return resolved;
    }
    return Object.is(state.key, key) ? state.value : null;
  }

  return { load, useValue };
}
