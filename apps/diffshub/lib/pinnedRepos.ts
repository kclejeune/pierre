// Repositories the user has pinned to the /pulls dashboard, stored as one
// localStorage array of "owner/name" strings. Pins are shared across surfaces
// (dashboard, viewer header, command palette), so saves broadcast a window
// event that lets other mounted consumers refresh without a reload.

const STORAGE_KEY = 'diffshub.pinned-repos';

export const MAX_PINNED_REPOS = 10;
export const PINNED_REPOS_EVENT = 'diffshub:pinned-repos';

const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export function isValidRepoName(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

export function loadPinnedRepos(): string[] {
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
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(repos.slice(0, MAX_PINNED_REPOS))
    );
    window.dispatchEvent(new CustomEvent(PINNED_REPOS_EVENT));
  } catch {
    // Storage unavailable; pins still hold for this session.
  }
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
