// Repositories the user has pinned to the /pulls dashboard, stored as one
// localStorage array of "owner/name" strings. Pins are shared across surfaces
// (dashboard, viewer header, command palette), so saves broadcast a window
// event that lets other mounted consumers refresh without a reload. Stored as
// a synced preference (lib/preferenceSync), so pins follow signed-in viewers
// across browsers.

import { readSyncedItem, writeSyncedItem } from './preferenceSync';

export const MAX_PINNED_REPOS = 10;
export const PINNED_REPOS_EVENT = 'diffshub:pinned-repos';

const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export function isValidRepoName(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

export function loadPinnedRepos(): string[] {
  const raw = readSyncedItem('pinnedRepos');
  if (raw == null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const repos: string[] = [];
  for (const entry of parsed) {
    if (
      typeof entry === 'string' &&
      isValidRepoName(entry) &&
      !isRepoPinned(repos, entry)
    ) {
      repos.push(entry);
    }
    if (repos.length >= MAX_PINNED_REPOS) {
      break;
    }
  }
  return repos;
}

export function savePinnedRepos(repos: string[]): void {
  writeSyncedItem(
    'pinnedRepos',
    JSON.stringify(repos.slice(0, MAX_PINNED_REPOS))
  );
  window.dispatchEvent(new CustomEvent(PINNED_REPOS_EVENT));
}

export function isRepoPinned(repos: readonly string[], repo: string): boolean {
  const needle = repo.toLowerCase();
  return repos.some((entry) => entry.toLowerCase() === needle);
}

// Pure toggle used by every pin control: removes the repo when present
// (case-insensitively) and appends it otherwise, enforcing the pin cap.
export function togglePinnedRepo(
  repos: readonly string[],
  repo: string
): string[] {
  const needle = repo.toLowerCase();
  if (isRepoPinned(repos, repo)) {
    return repos.filter((entry) => entry.toLowerCase() !== needle);
  }
  if (!isValidRepoName(repo) || repos.length >= MAX_PINNED_REPOS) {
    return [...repos];
  }
  return [...repos, repo];
}
