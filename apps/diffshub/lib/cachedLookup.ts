import { useEffect, useState } from 'react';

export interface CachedLookup<K, V> {
  // Starts (or joins) the fetch for a key. Concurrent callers share one
  // in-flight promise; settled results — including null failures — are cached
  // so a key is fetched at most once.
  load(key: K): Promise<V | null>;
  // Subscribes a component to a key's value. Resolved keys render
  // synchronously from the cache; unresolved keys return null until the fetch
  // settles. Pass null to skip the lookup entirely.
  useValue(key: K | null): V | null;
}

// Builds a module-level fetch cache shared by every mount of a hook: one
// request per key instead of one per component, with failures cached as null
// so a bad key does not retrigger a request storm. Backs hooks like
// useGitHubUser and useGitHubUserName, which need late-mounting consumers
// (e.g. thread cards scrolled into view) to render cached values
// synchronously.
export function createCachedLookup<K, V>(
  fetcher: (key: K) => Promise<V | null>
): CachedLookup<K, V> {
  const pendingByKey = new Map<K, Promise<V | null>>();
  const resolvedByKey = new Map<K, V | null>();

  function load(key: K): Promise<V | null> {
    let pending = pendingByKey.get(key);
    if (pending == null) {
      pending = fetcher(key).catch(() => null);
      void pending.then((value) => resolvedByKey.set(key, value));
      pendingByKey.set(key, pending);
    }
    return pending;
  }

  function useValue(key: K | null): V | null {
    const [value, setValue] = useState<V | null>(() =>
      key == null ? null : (resolvedByKey.get(key) ?? null)
    );

    useEffect(() => {
      if (key == null) {
        return;
      }
      let cancelled = false;
      void load(key).then((resolvedValue) => {
        if (!cancelled) {
          setValue(resolvedValue);
        }
      });
      return () => {
        cancelled = true;
      };
    }, [key]);

    return key == null ? null : value;
  }

  return { load, useValue };
}
