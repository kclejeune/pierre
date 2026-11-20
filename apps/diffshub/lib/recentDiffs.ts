// Recently viewed diffs, stored as one localStorage array ordered most recent
// first. The viewer records path-only entries (the patch stream carries no PR
// title); dashboard and palette clicks record with a title, and merging keeps
// whichever title is known so path-only revisits never erase one. Every
// path is stored in one canonical form (canonicalRecentPath), so the same
// view opened through different links lists once.

import { domainViewerHref } from './getPatchViewerHref';
import { normalizeGitHubPath } from './normalizeGitHubPath';
import { isPullsListPath } from './pullsListPath';

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
    const path = canonicalRecentPath(record.path);
    // Entries stored before a path stopped counting as a view (a
    // /owner/repo/pulls list, once served by the viewer) drop out here.
    if (!isRecentDiffPath(path)) {
      continue;
    }
    const title =
      typeof record.title === 'string' && record.title !== ''
        ? record.title
        : undefined;
    // Entries stored before paths were canonical can name one view twice;
    // the first (most recent) stays, taking a title only a later one knew.
    const earlier = entries.find(
      (entry) => recentKey(entry.path) === recentKey(path)
    );
    if (earlier != null) {
      earlier.path = keepReturnLink(earlier.path, path);
      earlier.title ??= title;
      continue;
    }
    entries.push(
      title == null
        ? { path, viewedAt: record.viewedAt }
        : { path, title, viewedAt: record.viewedAt }
    );
    if (entries.length >= MAX_RECENT_DIFFS) {
      break;
    }
  }
  return entries;
}

// One view's path in the form recents store it: the pathname, with GitHub
// paths in the viewer's canonical form (no trailing slash, a pull's /files
// tab as the pull, a pull commit as that commit), keeping only the query a
// reopened view needs: ?domain= for a patch from another host and
// ?fromPull= for a commit view's way back to its pull. A hash or a ?queue=
// only says where in the view, or how it was reached.
export function canonicalRecentPath(path: string): string {
  let url: URL;
  try {
    url = new URL(path, 'https://recents.invalid');
  } catch {
    return path;
  }
  const domain = url.searchParams.get('domain');
  const fromPull = url.searchParams.get('fromPull');
  const trimmed = url.pathname.replace(/\/+$/, '');
  const pathname =
    domain == null || domain === ''
      ? normalizeGitHubPath(url.pathname)
      : trimmed === ''
        ? '/'
        : trimmed;
  const kept = new URLSearchParams();
  if (domain != null && domain !== '') {
    kept.set('domain', domain);
  }
  if (fromPull != null && fromPull !== '') {
    kept.set('fromPull', fromPull);
  }
  const query = kept.toString();
  return query === '' ? pathname : `${pathname}?${query}`;
}

// Which view a canonical path names: ?fromPull= is only the way back, and
// on GitHub (no ?domain=) owner and repo match in any case, as GitHub treats
// them. Another host's paths keep their case.
function recentKey(path: string): string {
  let url: URL;
  try {
    url = new URL(path, 'https://recents.invalid');
  } catch {
    // An unparseable stored path only matches itself.
    return path;
  }
  const domain = url.searchParams.get('domain');
  if (domain != null) {
    return domainViewerHref(url.pathname, domain);
  }
  const [, owner = '', repo = '', ...rest] = url.pathname.split('/');
  return ['', owner.toLowerCase(), repo.toLowerCase(), ...rest].join('/');
}

// Which of two paths naming one view to keep: `path`, unless only `other`
// carries a ?fromPull= way back to the pull (the viewer records only its
// pathname, so a bare revisit would otherwise drop it).
function keepReturnLink(path: string, other: string): string {
  return !path.includes('fromPull=') && other.includes('fromPull=')
    ? other
    : path;
}

// Pure merge core: moves the entry's path to the front, preferring the new
// title but preserving a previously stored one when the new entry has none.
export function mergeRecentDiff(
  entries: readonly RecentDiff[],
  entry: { path: string; title?: string },
  viewedAt: number
): RecentDiff[] {
  const path = canonicalRecentPath(entry.path);
  const key = recentKey(path);
  const existing = entries.find(
    (candidate) => recentKey(candidate.path) === key
  );
  const merged: RecentDiff = {
    path: existing == null ? path : keepReturnLink(path, existing.path),
    viewedAt,
  };
  const title = entry.title ?? existing?.title;
  if (title != null && title !== '') {
    merged.title = title;
  }
  return [
    merged,
    ...entries.filter((candidate) => recentKey(candidate.path) !== key),
  ].slice(0, MAX_RECENT_DIFFS);
}

// The app's own dashboards and home page, which are where views are picked
// from rather than views worth listing.
const NOT_A_VIEW = /^\/(browse)?\/?(?:[?#]|$)/;

export function isRecentDiffPath(path: string): boolean {
  return !NOT_A_VIEW.test(path) && !isPullsListPath(path);
}

export function recordRecentDiff(entry: {
  path: string;
  title?: string;
}): void {
  if (!isRecentDiffPath(canonicalRecentPath(entry.path))) {
    return;
  }
  try {
    const merged = mergeRecentDiff(loadRecentDiffs(), entry, Date.now());
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Storage unavailable; recents still hold for this session.
  }
}

// Adds `title` to the entry recorded for `path`, leaving its place and
// time alone; nothing when the view isn't listed (it never loaded, or it
// left the list). For a title that arrives apart from the visit itself.
export function addRecentDiffTitle(entry: {
  path: string;
  title: string;
}): void {
  if (entry.title === '') {
    return;
  }
  try {
    const entries = loadRecentDiffs();
    const key = recentKey(canonicalRecentPath(entry.path));
    const listed = entries.find(
      (candidate) => recentKey(candidate.path) === key
    );
    if (listed == null || listed.title === entry.title) {
      return;
    }
    listed.title = entry.title;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable; the entry keeps its path as its label.
  }
}
