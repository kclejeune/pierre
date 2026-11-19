// Client-side cache of the /pulls rows' CI and review state, which the
// dashboard reads from /api/pull-statuses after the list itself (see
// components/usePullStatuses). Entries are keyed by token version, node id,
// and the pull's updatedAt, so a pull that changed (a review, a push) or a
// new token reads afresh, and they count as fresh for PULL_STATUS_TTL_MS so
// CI that finished since (which doesn't bump updatedAt) shows up on the
// next list load after that. A stale entry still shows until its
// replacement lands, so revisiting a list doesn't blank its badges.
//
// Reads in flight are tracked by key, so a list whose rows are replaced by
// equal ones (cached rows, then the network's) doesn't read the same
// statuses twice, and every mounted list hears when a read lands
// (subscribePullStatuses), whichever list started it.

import {
  pullKey,
  type PullStatus,
  type PullSummary,
} from './githubPullSummaries';

// Long enough that switching filters or tabs and coming back reuses the
// badges; reviews and pushes bump updatedAt, which re-keys the entry anyway.
export const PULL_STATUS_TTL_MS = 60_000;

// Past this many entries, storing evicts the least recently stored ones.
const MAX_ENTRIES = 1000;

interface StatusEntry {
  fetchedAt: number;
  status: PullStatus;
}

const entries = new Map<string, StatusEntry>();
// Keys whose read has been sent and hasn't landed.
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

// Calls `listener` whenever statuses are stored. Returns the unsubscribe.
export function subscribePullStatuses(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function statusKey(pull: PullSummary, tokenVersion: number): string | null {
  return pull.nodeId == null
    ? null
    : `${tokenVersion}:${pull.nodeId}:${pull.updatedAt}`;
}

// The pulls whose status is missing or older than PULL_STATUS_TTL_MS, in
// list order. Pulls without a node id (a response cached from before the
// list carried them) have no status to read.
export function pullsNeedingStatus(
  pulls: readonly PullSummary[],
  tokenVersion: number,
  now: number
): PullSummary[] {
  return pulls.filter((pull) => {
    const key = statusKey(pull, tokenVersion);
    if (key == null) {
      return false;
    }
    if (inFlight.has(key)) {
      return false;
    }
    const entry = entries.get(key);
    return entry == null || now - entry.fetchedAt >= PULL_STATUS_TTL_MS;
  });
}

// Records that a read for `pulls` was sent, so pullsNeedingStatus skips
// them until storePullStatuses records the answer.
export function markPullStatusesInFlight(
  pulls: readonly PullSummary[],
  tokenVersion: number
): void {
  for (const pull of pulls) {
    const key = statusKey(pull, tokenVersion);
    if (key != null) {
      inFlight.add(key);
    }
  }
}

// Records the statuses read for `requested`. A requested pull missing from
// `statuses` (unreadable, or the whole read failed: pass {}) is stored with
// no status, so its row stops waiting for one until the entry goes stale.
export function storePullStatuses(
  requested: readonly PullSummary[],
  tokenVersion: number,
  statuses: Readonly<Record<string, PullStatus>>,
  now: number
): void {
  for (const pull of requested) {
    const key = statusKey(pull, tokenVersion);
    if (key != null && pull.nodeId != null) {
      inFlight.delete(key);
      // Re-inserted so the Map's order stays oldest-stored first.
      entries.delete(key);
      entries.set(key, { fetchedAt: now, status: statuses[pull.nodeId] ?? {} });
    }
  }
  for (const key of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) {
      break;
    }
    entries.delete(key);
  }
  for (const listener of listeners) {
    listener();
  }
}

interface AppliedStatuses {
  pending: ReadonlySet<string>;
  pulls: PullSummary[];
}

// Each list row's last merged copy, reused while its status reads the same,
// so a read landing for other rows (or another list) doesn't hand every
// memoized row a new object.
const mergedRows = new WeakMap<PullSummary, PullSummary>();
// Each row list's last result, returned again when no row changed.
const lastApplied = new WeakMap<readonly PullSummary[], AppliedStatuses>();

function sameStatus(pull: PullSummary, status: PullStatus): boolean {
  return (
    pull.checks === status.checks &&
    pull.reviewDecision === status.reviewDecision
  );
}

// The pulls with their cached status filled in, plus the keys (pullKey) of
// rows still waiting for one, which reserve room for the CI glyph.
export function applyPullStatuses(
  pulls: readonly PullSummary[],
  tokenVersion: number
): AppliedStatuses {
  const pending = new Set<string>();
  const merged = pulls.map((pull) => {
    const key = statusKey(pull, tokenVersion);
    const entry = key == null ? undefined : entries.get(key);
    if (entry == null) {
      if (key != null) {
        pending.add(pullKey(pull));
      }
      return pull;
    }
    const previous = mergedRows.get(pull);
    if (previous != null && sameStatus(previous, entry.status)) {
      return previous;
    }
    const next = { ...pull, ...entry.status };
    mergedRows.set(pull, next);
    return next;
  });
  const last = lastApplied.get(pulls);
  if (
    last != null &&
    last.pending.size === pending.size &&
    last.pulls.every((row, index) => row === merged[index])
  ) {
    return last;
  }
  const result = { pending, pulls: merged };
  lastApplied.set(pulls, result);
  return result;
}

// For tests: forget every status.
export function clearPullStatuses(): void {
  entries.clear();
  inFlight.clear();
}
