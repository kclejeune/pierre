// The pull request queue: a /pulls list in its on-screen order, so a diff
// opened from it can step to the next or previous pull without going back to
// the list. Each list the viewer opens a diff from is saved under an id
// derived from its rows, and the dashboard's diff links carry that id as
// ?queue= into the tab they open. On arrival the diff view moves the id into
// that tab's session storage and drops it from the URL
// (claimTabPullQueueId), so the address bar, and any link copied from it,
// stays plain, and the tab keeps its queue across reloads, back/forward, and
// the stepper's own steps. The header shows its stepper only while the
// tab's queue holds the open pull, and two tabs opened from different lists
// step through their own lists.
//
// The lists themselves live in localStorage rather than sessionStorage: the
// dashboard opens diffs in new tabs without an opener, and those tabs start
// with empty session storage, so only the id can travel, in the URL.

import { consumeSearchParam, withSearchParam } from './searchParams';
import { readStoredJSON, writeStoredJSON } from './storedJSON';

// Each saved list sits under its own key (this prefix plus its id), so two
// dashboard tabs saving at once can't overwrite each other's lists.
const STORAGE_PREFIX = 'diffshub.pull-queue.';
// This tab's queue id, in sessionStorage.
const TAB_QUEUE_KEY = 'diffshub.tab-pull-queue';
// Where the single queue lived before lists were kept per id.
const LEGACY_STORAGE_KEY = 'diffshub.pull-queue';
// The URL parameter naming the queue a diff was opened from.
export const PULL_QUEUE_PARAM = 'queue';
// Long lists are trimmed; nobody steps through more than this in one sitting.
const MAX_QUEUE_LENGTH = 200;
// Lists kept at once; the oldest is dropped first.
const MAX_STORED_QUEUES = 10;
// A queue older than this is a list the viewer has moved on from.
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PullQueueItem {
  // App-relative diff path, e.g. /acme/widgets/pull/12.
  path: string;
  title: string;
}

export interface PullQueue {
  items: PullQueueItem[];
  // The /pulls URL (path and query) the list was showing, so the stepper can
  // lead back to the same filters.
  listPath: string;
}

interface StoredQueue extends PullQueue {
  savedAt: number;
}

function isQueueItem(value: unknown): value is PullQueueItem {
  return (
    typeof value === 'object' &&
    value != null &&
    typeof (value as PullQueueItem).path === 'string' &&
    (value as PullQueueItem).path.startsWith('/') &&
    typeof (value as PullQueueItem).title === 'string'
  );
}

// A short, stable id for a list (FNV-1a over its /pulls filters and its
// rows' paths), so the rows' links can name the queue before any click
// saves it. The same list always names the same queue, and two filters
// that happen to show the same rows still name different ones, so each
// keeps its own way back.
export function pullQueueId(
  items: readonly PullQueueItem[],
  listKey = ''
): string {
  let hash = 0x811c9dc5;
  for (const text of [
    listKey,
    ...items.slice(0, MAX_QUEUE_LENGTH).map((item) => item.path),
  ]) {
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// `path` with the queue named, for a diff link opened from a /pulls list;
// unchanged when there is no queue.
export function withPullQueue(
  path: string,
  queueId: string | null | undefined
): string {
  return queueId == null
    ? path
    : withSearchParam(path, PULL_QUEUE_PARAM, queueId);
}

// Whether `value` has the shape pullQueueId produces (base36 of a 32-bit
// hash), so a hand-edited URL can't name arbitrary storage keys or text.
export function isPullQueueId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z]{1,7}$/.test(value);
}

// The queue id a page's search string names, or null.
export function readPullQueueId(search: string): string | null {
  const id = new URLSearchParams(search).get(PULL_QUEUE_PARAM);
  return isPullQueueId(id) ? id : null;
}

// The queue this tab steps through. A ?queue= in the URL naming a list this
// browser saved becomes the tab's queue; one it didn't save (a link someone
// else copied mid-queue) is ignored, leaving the tab's queue as it was.
// Either way the parameter is dropped from the URL in place (no
// navigation), so it never lingers to be copied or bookmarked. Returns the
// queue itself, read from storage once.
export function claimTabPullQueue(): PullQueue | null {
  const arrived = consumeSearchParam(PULL_QUEUE_PARAM);
  if (isPullQueueId(arrived)) {
    const queue = loadPullQueue(arrived);
    if (queue != null) {
      try {
        window.sessionStorage.setItem(TAB_QUEUE_KEY, arrived);
      } catch {
        // Storage unavailable; the queue still applies to this page.
      }
      return queue;
    }
  }
  let id: string | null = null;
  try {
    id = window.sessionStorage.getItem(TAB_QUEUE_KEY);
  } catch {
    return null;
  }
  return isPullQueueId(id) ? loadPullQueue(id) : null;
}

// Reads one saved queue (as parsed JSON); a missing, malformed, or expired
// entry reads as null.
export function parsePullQueue(value: unknown, now: number): PullQueue | null {
  const stored = value as Partial<StoredQueue> | null;
  if (
    typeof stored?.savedAt !== 'number' ||
    now - stored.savedAt > QUEUE_TTL_MS ||
    !Array.isArray(stored.items) ||
    typeof stored.listPath !== 'string' ||
    !stored.listPath.startsWith('/pulls')
  ) {
    return null;
  }
  return {
    items: stored.items.filter(isQueueItem).slice(0, MAX_QUEUE_LENGTH),
    listPath: stored.listPath,
  };
}

export function loadPullQueue(id: string): PullQueue | null {
  return parsePullQueue(readStoredJSON(STORAGE_PREFIX + id), Date.now());
}

// Which saved queues to drop, given each one's savedAt (null when its entry
// is unreadable): the expired and unreadable ones, then the oldest past
// MAX_STORED_QUEUES.
export function staleQueueIds(
  saved: ReadonlyMap<string, number | null>,
  now: number
): string[] {
  const stale: string[] = [];
  const live: [string, number][] = [];
  for (const [id, savedAt] of saved) {
    if (savedAt == null || now - savedAt > QUEUE_TTL_MS) {
      stale.push(id);
    } else {
      live.push([id, savedAt]);
    }
  }
  live.sort((a, b) => b[1] - a[1]);
  return [...stale, ...live.slice(MAX_STORED_QUEUES).map(([id]) => id)];
}

// Saves (or refreshes) one queue under its own key, then trims the others.
export function savePullQueue(id: string, queue: PullQueue): void {
  const now = Date.now();
  writeStoredJSON(STORAGE_PREFIX + id, {
    items: queue.items.slice(0, MAX_QUEUE_LENGTH),
    listPath: queue.listPath,
    savedAt: now,
  } satisfies StoredQueue);
  try {
    const saved = new Map<string, number | null>();
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX) === true) {
        const savedAt = (readStoredJSON(key) as Partial<StoredQueue> | null)
          ?.savedAt;
        saved.set(
          key.slice(STORAGE_PREFIX.length),
          typeof savedAt === 'number' ? savedAt : null
        );
      }
    }
    for (const stale of staleQueueIds(saved, now)) {
      window.localStorage.removeItem(STORAGE_PREFIX + stale);
    }
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage unavailable; nothing to trim.
  }
}

// Where the current page sits in the queue: the queued pull itself, a page
// under it, or a commit or compare view opened from it. Those views live at
// /<owner>/<repo>/commit/<sha> and name their pull only in the ?fromPull=
// parameter (lib/pullCommitsList's commitRangeViewerHref), so `fromPull`
// counts as the pull's own path. -1 when the page isn't queued.
export function findQueuePosition(
  items: readonly PullQueueItem[],
  pathname: string,
  fromPull?: string | null
): number {
  const candidates = [pathname, fromPull]
    .filter((path): path is string => path != null && path.startsWith('/'))
    .map((path) => path.replace(/\/$/, '').toLowerCase());
  return items.findIndex((item) => {
    const queued = item.path.toLowerCase();
    return candidates.some(
      (path) => path === queued || path.startsWith(`${queued}/`)
    );
  });
}
