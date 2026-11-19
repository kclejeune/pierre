// Responses fetched ahead of need, so the /pulls preview pane can show a
// pull's details as soon as it's selected: the dashboard prefetches the row
// under the pointer and the preview's J/K neighbors, and the client fetchers
// (pull info, the details supplement, review thread states) take a matching
// response from here before going to the network.
//
// Entries are single-use and short-lived (PREFETCH_TTL_MS), so a taken
// response is never served twice and nothing older than a few seconds of
// hovering stands in for a fresh read. Keys include the token, so a
// different token (sign-in, a new paste) never sees another's response.
//
// Prefetches can be started under a PrefetchGroup (one per hovered row, one
// per J/K neighbor pair), and cancelling the group aborts its requests that
// nobody has taken yet, so moving on to another row stops the old row's
// requests instead of letting them run to completion. A request that
// another live group also asked for keeps running, and one already taken by
// a reader is out of the store and never aborted.
//
// Entries can carry a tag (the pull they belong to), and discardTagged drops
// every entry with that tag, so a write to a pull (lib/pullChangeEvents)
// keeps any reader from taking a response that predates it.

const PREFETCH_TTL_MS = 30_000;

interface PrefetchEntry {
  // Whether cancelling groups can abort this entry: false when it was
  // started outside any group, since that caller asked for it to finish.
  abortable: boolean;
  controller: AbortController;
  // Groups that asked for this entry and haven't been cancelled.
  groups: Set<PrefetchGroup>;
  promise: Promise<unknown>;
  tag: string | undefined;
  // The PREFETCH_TTL_MS expiry, cleared whenever the entry leaves the store
  // so a taken or aborted response isn't held until it fires.
  timer: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, PrefetchEntry>();

// Removes `key` if it still holds `entry` (not a newer prefetch), clearing
// its expiry timer.
function removeEntry(key: string, entry: PrefetchEntry): void {
  if (entries.get(key) === entry) {
    entries.delete(key);
    clearTimeout(entry.timer);
  }
}

// A set of prefetches that can be abandoned together. `keys` is null once
// cancelled, so prefetches started under it afterwards don't join it.
export class PrefetchGroup {
  private keys: Set<string> | null = new Set();

  // Records `key` as one of this group's entries; false once cancelled.
  join(key: string): boolean {
    this.keys?.add(key);
    return this.keys != null;
  }

  cancel(): void {
    const keys = this.keys;
    this.keys = null;
    for (const key of keys ?? []) {
      const entry = entries.get(key);
      if (
        entry != null &&
        entry.groups.delete(this) &&
        entry.abortable &&
        entry.groups.size === 0
      ) {
        removeEntry(key, entry);
        entry.controller.abort();
      }
    }
  }
}

function entryKey(url: string, token: string | undefined): string {
  return `${token ?? ''}\n${url}`;
}

// Joins `group` (when given and not cancelled) to `entry`.
function addToGroup(
  key: string,
  entry: PrefetchEntry,
  group: PrefetchGroup | undefined
) {
  if (group?.join(key) === true) {
    entry.groups.add(group);
  }
}

// Starts `load` for `url` unless a prefetch for it (with the same token) is
// already held, in which case `group` joins that one. `load` receives the
// signal that cancelling every group holding the entry aborts. Failures
// leave the store, so the reader fetches for itself. `tag` is what
// discardTagged matches.
export function prefetchOnce(
  url: string,
  token: string | undefined,
  load: (signal: AbortSignal) => Promise<unknown>,
  { group, tag }: { group?: PrefetchGroup; tag?: string } = {}
): Promise<unknown> {
  const key = entryKey(url, token);
  const held = entries.get(key);
  if (held != null) {
    addToGroup(key, held, group);
    return held.promise;
  }
  const controller = new AbortController();
  const entry: PrefetchEntry = {
    abortable: group != null,
    controller,
    groups: new Set(),
    promise: load(controller.signal),
    tag,
    timer: setTimeout(() => removeEntry(key, entry), PREFETCH_TTL_MS),
  };
  entries.set(key, entry);
  addToGroup(key, entry, group);
  entry.promise.catch(() => removeEntry(key, entry));
  return entry.promise;
}

// The fetchers' read: the prefetched response for `url` when one is held
// (removing it, so it serves once and no group can abort it any more),
// otherwise `load`. A failed prefetch also falls back to `load`.
export function takeOrLoad<T>(
  url: string,
  token: string | undefined,
  load: () => Promise<T>
): Promise<T> {
  const key = entryKey(url, token);
  const held = entries.get(key);
  if (held == null) {
    return load();
  }
  removeEntry(key, held);
  return (held.promise as Promise<T>).catch(load);
}

// Drops any prefetch held for `url`, for a caller that just read it fresh
// (a forced refresh after an edit), so a later plain read can't take the
// older response.
export function discardPrefetch(url: string, token: string | undefined) {
  const key = entryKey(url, token);
  const held = entries.get(key);
  if (held != null) {
    removeEntry(key, held);
  }
}

// Drops every held prefetch tagged `tag`, whatever its URL or token. An
// entry still loading finishes (a group may still want it) but can no
// longer be taken.
export function discardTagged(tag: string) {
  for (const [key, entry] of entries) {
    if (entry.tag === tag) {
      removeEntry(key, entry);
    }
  }
}

// For tests: forget every prefetch.
export function clearPrefetches() {
  for (const entry of entries.values()) {
    clearTimeout(entry.timer);
  }
  entries.clear();
}
