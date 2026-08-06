// Recently viewed diffs, stored as one localStorage array ordered most recent
// first. The viewer records path-only entries (the patch stream carries no PR
// title); dashboard and palette clicks record with a title, and merging keeps
// whichever title is known so path-only revisits never erase one.

const STORAGE_KEY = 'diffshub.recent-diffs';

export const MAX_RECENT_DIFFS = 20;

export interface RecentDiff {
  path: string;
  title?: string;
  viewedAt: number;
}

export function loadRecentDiffs(): RecentDiff[] {
  let parsed: unknown;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) {
      return [];
    }
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const entries: RecentDiff[] = [];
  for (const value of parsed) {
    if (typeof value !== 'object' || value == null) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.path !== 'string' ||
      record.path === '' ||
      typeof record.viewedAt !== 'number'
    ) {
      continue;
    }
    const entry: RecentDiff = {
      path: record.path,
      viewedAt: record.viewedAt,
    };
    if (typeof record.title === 'string' && record.title !== '') {
      entry.title = record.title;
    }
    entries.push(entry);
    if (entries.length >= MAX_RECENT_DIFFS) {
      break;
    }
  }
  return entries;
}

// Pure merge core: moves the entry's path to the front, preferring the new
// title but preserving a previously stored one when the new entry has none.
export function mergeRecentDiff(
  entries: readonly RecentDiff[],
  entry: { path: string; title?: string },
  viewedAt: number
): RecentDiff[] {
  const existing = entries.find((candidate) => candidate.path === entry.path);
  const merged: RecentDiff = { path: entry.path, viewedAt };
  const title = entry.title ?? existing?.title;
  if (title != null && title !== '') {
    merged.title = title;
  }
  return [
    merged,
    ...entries.filter((candidate) => candidate.path !== entry.path),
  ].slice(0, MAX_RECENT_DIFFS);
}

export function recordRecentDiff(entry: {
  path: string;
  title?: string;
}): void {
  try {
    const merged = mergeRecentDiff(loadRecentDiffs(), entry, Date.now());
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Storage unavailable; recents still hold for this session.
  }
}
