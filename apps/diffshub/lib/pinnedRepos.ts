// Repositories the user has pinned to the /pulls dashboard, stored as one
// localStorage array of "owner/name" strings. Pins are shared across surfaces
// (dashboard, viewer header, command palette), so saves broadcast a window
// event that lets other mounted consumers refresh without a reload. Stored as
// a synced preference (lib/preferenceSync), so pins follow signed-in viewers
// across browsers.

import { includesName, parseNameList, withoutName } from './nameList';
import { readSyncedItem, writeSyncedItem } from './preferenceSync';

export const MAX_PINNED_REPOS = 10;
export const PINNED_REPOS_EVENT = 'diffshub:pinned-repos';

const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export function isValidRepoName(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

// A valid "owner/name" split into its parts, shaped like GitHubRepo.
export function splitRepoName(repo: string): { owner: string; repo: string } {
  const separator = repo.indexOf('/');
  return { owner: repo.slice(0, separator), repo: repo.slice(separator + 1) };
}

// Reads a stored "owner/name" list (pins, the /pulls recents): valid names
// only, de-duplicated case-insensitively keeping the first, capped at `max`.
// Anything that isn't an array reads as empty.
export function parseRepoList(value: unknown, max: number): string[] {
  return parseNameList(value, isValidRepoName, max);
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
  return parseRepoList(parsed, MAX_PINNED_REPOS);
}

export function savePinnedRepos(repos: string[]): void {
  writeSyncedItem(
    'pinnedRepos',
    JSON.stringify(repos.slice(0, MAX_PINNED_REPOS))
  );
  window.dispatchEvent(new CustomEvent(PINNED_REPOS_EVENT));
}

export function isRepoPinned(repos: readonly string[], repo: string): boolean {
  return includesName(repos, repo);
}

// Pure toggle used by every pin control: removes the repo when present
// (case-insensitively) and appends it otherwise, enforcing the pin cap.
export function togglePinnedRepo(
  repos: readonly string[],
  repo: string
): string[] {
  if (isRepoPinned(repos, repo)) {
    return withoutName(repos, repo);
  }
  if (!isValidRepoName(repo) || repos.length >= MAX_PINNED_REPOS) {
    return [...repos];
  }
  return [...repos, repo];
}
