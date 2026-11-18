// The pull request queue: the /pulls list the viewer last looked at, in its
// on-screen order, so a diff opened from it can step to the next or previous
// pull without going back to the list. The dashboard saves its visible rows
// when it opens a diff; the diff view's header reads them and shows a
// stepper while the open pull is one of them.
//
// localStorage rather than sessionStorage: the dashboard opens diffs in new
// tabs without an opener, and those tabs start with empty session storage.

import { readStoredJSON, writeStoredJSON } from './storedJSON';

const STORAGE_KEY = 'diffshub.pull-queue';
// Long lists are trimmed; nobody steps through more than this in one sitting.
const MAX_QUEUE_LENGTH = 200;
// A queue older than this is a list the viewer has moved on from.
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PullQueueItem {
  // App-relative diff path, e.g. /acme/widgets/pull/12.
  path: string;
  title: string;
}

interface StoredQueue {
  items: PullQueueItem[];
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

// Reads a stored queue (as parsed JSON); anything malformed or expired reads
// as empty.
export function parsePullQueue(value: unknown, now: number): PullQueueItem[] {
  const stored = value as Partial<StoredQueue> | null;
  if (
    typeof stored?.savedAt !== 'number' ||
    now - stored.savedAt > QUEUE_TTL_MS ||
    !Array.isArray(stored.items)
  ) {
    return [];
  }
  return stored.items.filter(isQueueItem).slice(0, MAX_QUEUE_LENGTH);
}

export function loadPullQueue(): PullQueueItem[] {
  return parsePullQueue(readStoredJSON(STORAGE_KEY), Date.now());
}

export function savePullQueue(items: readonly PullQueueItem[]): void {
  const stored: StoredQueue = {
    items: items.slice(0, MAX_QUEUE_LENGTH),
    savedAt: Date.now(),
  };
  writeStoredJSON(STORAGE_KEY, stored);
}

// Where `pathname` sits in the queue: an exact match, or a page under a
// queued pull (its commit-range views). -1 when it isn't queued.
export function findQueuePosition(
  items: readonly PullQueueItem[],
  pathname: string
): number {
  const path = pathname.replace(/\/$/, '').toLowerCase();
  return items.findIndex((item) => {
    const queued = item.path.toLowerCase();
    return path === queued || path.startsWith(`${queued}/`);
  });
}
