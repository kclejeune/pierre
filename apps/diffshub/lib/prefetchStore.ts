// Responses fetched ahead of need, so the /pulls preview pane can show a
// pull's details as soon as it's selected: the dashboard prefetches the row
// under the pointer and the preview's J/K neighbors, and the client
// fetchers for routes the browser doesn't cache (the details supplement and
// review thread states) take a matching response from here before going to
// the network. /api/pull-info needs none of this: it's HTTP-cacheable, so
// its prefetch just warms the browser cache.
//
// Entries are single-use and short-lived (PREFETCH_TTL_MS), so a taken
// response is never served twice and nothing older than a few seconds of
// hovering stands in for a fresh read. Keys include the token, so a
// different token (sign-in, a new paste) never sees another's response.

const PREFETCH_TTL_MS = 30_000;

const entries = new Map<string, Promise<unknown>>();

function entryKey(url: string, token: string | undefined): string {
  return `${token ?? ''}\n${url}`;
}

// Drops `key` if it still holds `promise` (not a newer prefetch).
function forget(key: string, promise: Promise<unknown>) {
  if (entries.get(key) === promise) {
    entries.delete(key);
  }
}

// Starts `load` for `url` unless a prefetch for it (with the same token) is
// already held. Failures leave the store, so the reader fetches for itself.
export function prefetchOnce(
  url: string,
  token: string | undefined,
  load: () => Promise<unknown>
): void {
  const key = entryKey(url, token);
  if (entries.has(key)) {
    return;
  }
  const promise = load();
  entries.set(key, promise);
  promise.catch(() => forget(key, promise));
  setTimeout(() => forget(key, promise), PREFETCH_TTL_MS);
}

// The fetchers' read: the prefetched response for `url` when one is held
// (removing it, so it serves once), otherwise `load`. A failed prefetch also
// falls back to `load`.
export function takeOrLoad<T>(
  url: string,
  token: string | undefined,
  load: () => Promise<T>
): Promise<T> {
  const key = entryKey(url, token);
  const held = entries.get(key) as Promise<T> | undefined;
  if (held == null) {
    return load();
  }
  entries.delete(key);
  return held.catch(load);
}

// For tests: forget every prefetch.
export function clearPrefetches() {
  entries.clear();
}
