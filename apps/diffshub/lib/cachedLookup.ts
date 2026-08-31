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
    const [resolved, setResolved] = useState<{
      key: K;
      value: V | null;
    } | null>(() =>
      key == null ? null : { key, value: resolvedByKey.get(key) ?? null }
    );

    useEffect(() => {
      if (key == null) {
        return;
      }
      let cancelled = false;
      void load(key).then((value) => {
        if (!cancelled) {
          setResolved({ key, value });
        }
      });
      return () => {
        cancelled = true;
      };
    }, [key]);

    if (key == null) {
      return null;
    }
    // A key can change before its effect runs. Never expose the previous
    // key's value during that render; use a synchronously cached result for
    // the new key when one exists, otherwise return the unresolved sentinel.
    return resolved != null && Object.is(resolved.key, key)
      ? resolved.value
      : (resolvedByKey.get(key) ?? null);
  }

  return { load, useValue };
}

// A promise cache whose entries are valid for exactly one token generation
// (GitHubTokenSnapshot.version): touching it under a newer version drops the
// previous generation wholesale, so an identity change cannot serve values
// cached as someone else and steady-state reads stay O(1). The version is
// monotonic per page, so a stale caller carrying an older version simply
// bypasses the cache instead of clobbering the current generation. onEvict
// runs on each discarded entry's settled value (e.g. revoking blob object
// URLs).
export function createTokenScopedCache<V>(onEvict?: (value: V) => void): {
  delete(version: number, key: string): void;
  get(version: number, key: string): Promise<V> | undefined;
  set(version: number, key: string, pending: Promise<V>): void;
} {
  let scope: { version: number; entries: Map<string, Promise<V>> } | undefined;

  function entriesFor(version: number): Map<string, Promise<V>> | undefined {
    if (scope == null || version > scope.version) {
      if (scope != null && onEvict != null) {
        for (const stale of scope.entries.values()) {
          void stale.then(onEvict, () => undefined);
        }
      }
      scope = { version, entries: new Map() };
    }
    return version === scope.version ? scope.entries : undefined;
  }

  return {
    delete: (version, key) => {
      if (scope?.version === version) {
        scope.entries.delete(key);
      }
    },
    get: (version, key) => entriesFor(version)?.get(key),
    set: (version, key, pending) => {
      entriesFor(version)?.set(key, pending);
    },
  };
}

// createCachedLookup scoped to a token generation: each generation gets
// fresh maps and the previous ones are abandoned wholesale, so an auth
// failure or account switch cannot pin values fetched as the previous
// identity, and old generations do not accumulate for the page lifetime.
export function createTokenScopedLookup<V>(
  fetcher: (key: string) => Promise<V | null>
): { useValue(version: number, key: string | null): V | null } {
  let scope:
    | {
        version: number;
        pending: Map<string, Promise<V | null>>;
        resolved: Map<string, V | null>;
      }
    | undefined;

  // Monotonic like createTokenScopedCache: a stale render's older version
  // reads the current generation rather than resurrecting a discarded one.
  function scopeFor(version: number) {
    if (scope == null || version > scope.version) {
      scope = { version, pending: new Map(), resolved: new Map() };
    }
    return scope;
  }

  function load(version: number, key: string): Promise<V | null> {
    const generation = scopeFor(version);
    let pending = generation.pending.get(key);
    if (pending == null) {
      pending = fetcher(key).catch(() => null);
      void pending.then((value) => generation.resolved.set(key, value));
      generation.pending.set(key, pending);
    }
    return pending;
  }

  function useValue(version: number, key: string | null): V | null {
    const [resolved, setResolved] = useState<{
      key: string;
      value: V | null;
      version: number;
    } | null>(() =>
      key == null
        ? null
        : { key, value: scopeFor(version).resolved.get(key) ?? null, version }
    );

    useEffect(() => {
      if (key == null) {
        return;
      }
      let cancelled = false;
      void load(version, key).then((value) => {
        if (!cancelled) {
          setResolved({ key, value, version });
        }
      });
      return () => {
        cancelled = true;
      };
    }, [version, key]);

    if (key == null) {
      return null;
    }
    // Same rule as createCachedLookup.useValue: never expose a previous
    // key's — or a previous generation's — value during the render where it
    // changed.
    return resolved != null &&
      resolved.version === version &&
      Object.is(resolved.key, key)
      ? resolved.value
      : (scopeFor(version).resolved.get(key) ?? null);
  }

  return { useValue };
}
