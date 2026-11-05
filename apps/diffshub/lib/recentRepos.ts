import { parseRepoList } from './pinnedRepos';
import { readStoredJSON, writeStoredJSON } from './storedJSON';

// Recently chosen repositories, most recent first, for the command palette's
// idle list. Device-local: unlike pins, this is history rather than a choice
// worth syncing. The key predates the palette (it held the /pulls switcher's
// history), so existing history carries over.
const RECENT_REPOS_KEY = 'diffshub:recent-pull-repos';
const MAX_RECENT_REPOS = 6;

export function loadRecentRepos(): string[] {
  return parseRepoList(readStoredJSON(RECENT_REPOS_KEY), MAX_RECENT_REPOS);
}

export function recordRecentRepo(repo: string): void {
  writeStoredJSON(
    RECENT_REPOS_KEY,
    parseRepoList([repo, ...loadRecentRepos()], MAX_RECENT_REPOS)
  );
}
