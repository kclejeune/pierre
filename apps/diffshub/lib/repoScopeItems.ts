// The /pulls repo switcher's sections (cmd+K on that page), assembled from
// its data inputs so the ranking rules stay unit-testable. Ranking is local
// and synchronous over every repository the page already knows (pins,
// recents, the directory listing) so results keep up with typing. Below
// them, two remote tiers fill in repos outside that set: fuzzy matches from
// the viewer's organizations, then GitHub's repository search.

import { filterFilePathsForSearch } from './fileSearchFilter';
import { isRepoPinned, isValidRepoName } from './pinnedRepos';
import type { PullScope } from './pullScopes';

export interface RepoScopeItem {
  key: string;
  label: string;
  // Secondary text after the label.
  detail?: string;
  // What choosing the item does: switch the list's scope, or hand off to the
  // global diff switcher for anything that isn't a repository.
  action: { type: 'scope'; scope: PullScope } | { type: 'search-everywhere' };
  // Set on repository items, which can be pinned from the switcher.
  repo?: string;
}

interface RepoScopeSection {
  heading: string;
  items: RepoScopeItem[];
}

interface BuildRepoScopeInput {
  query: string;
  pinned: readonly string[];
  recents: readonly string[];
  // The viewer's repositories, most recently pushed first.
  directory: readonly string[];
  // Matches from the viewer's organizations (the org listing search),
  // already access-checked, possibly stale by a keystroke.
  orgMatches: readonly string[];
  // GitHub's repository-name search for the query, for repos outside the
  // viewer's orgs; possibly stale by a keystroke.
  remote: readonly string[];
  // knownRepos(pinned, recents, directory), when the caller keeps one
  // across keystrokes; computed here otherwise.
  known?: KnownRepos;
}

// Enough to fill the list without making the eye search through it.
const MAX_IDLE_DIRECTORY = 30;
export const MAX_REPO_MATCHES = 40;
const MAX_REMOTE = 8;

function repoItem(repo: string, detail?: string): RepoScopeItem {
  return {
    key: `repo:${repo.toLowerCase()}`,
    label: repo,
    detail,
    action: { type: 'scope', scope: { kind: 'repo', repo } },
    repo,
  };
}

// The repos the switcher knows locally (pins, then recents, then the
// directory), de-duplicated case-insensitively keeping first occurrences so
// a pinned repo's own casing wins over the directory's, plus their lowercase
// names for membership checks. It doesn't depend on the query, so callers
// keep one across keystrokes: the matcher caches lowercase paths by array
// identity, and the remote tiers check membership against `seen`.
export interface KnownRepos {
  repos: string[];
  seen: ReadonlySet<string>;
}

export function knownRepos(
  pinned: readonly string[],
  recents: readonly string[],
  directory: readonly string[]
): KnownRepos {
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const list of [pinned, recents, directory]) {
    for (const repo of list) {
      const key = repo.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        repos.push(repo);
      }
    }
  }
  return { repos, seen };
}

export function buildRepoScopeSections(
  input: BuildRepoScopeInput
): RepoScopeSection[] {
  const query = input.query.trim();
  const sections: RepoScopeSection[] = [];

  if (query === '') {
    const scopes: RepoScopeItem[] = [
      {
        key: 'scope:all',
        label: 'All repositories',
        detail: 'Pull requests involving you, anywhere',
        action: { type: 'scope', scope: { kind: 'all' } },
      },
    ];
    if (input.pinned.length > 0) {
      scopes.push({
        key: 'scope:pinned',
        label: 'Pinned repositories',
        detail:
          input.pinned.length === 1
            ? '1 repository'
            : `${input.pinned.length} repositories`,
        action: { type: 'scope', scope: { kind: 'pinned' } },
      });
    }
    sections.push({ heading: 'Scopes', items: scopes });
    if (input.pinned.length > 0) {
      sections.push({
        heading: 'Pinned',
        items: input.pinned.map((repo) => repoItem(repo)),
      });
    }
    const recents = input.recents.filter(
      (repo) => !isRepoPinned(input.pinned, repo)
    );
    if (recents.length > 0) {
      sections.push({
        heading: 'Recent',
        items: recents.map((repo) => repoItem(repo)),
      });
    }
    const shown = new Set(
      [...input.pinned, ...recents].map((repo) => repo.toLowerCase())
    );
    const directory = input.directory
      .filter((repo) => !shown.has(repo.toLowerCase()))
      .slice(0, MAX_IDLE_DIRECTORY);
    if (directory.length > 0) {
      sections.push({
        heading: 'Your repositories',
        items: directory.map((repo) => repoItem(repo)),
      });
    }
    return sections;
  }

  const known =
    input.known ?? knownRepos(input.pinned, input.recents, input.directory);
  // The go-to-file ranker treats "owner/name" as a path, so a hit in the
  // repository name beats a hit in the owner, which beats a scattered
  // subsequence ("dfhb" → diffshub).
  const matches = filterFilePathsForSearch(
    known.repos,
    query,
    MAX_REPO_MATCHES
  );
  // A complete "owner/name" that nothing loaded matches still deserves a
  // direct entry: it may be public, or outside the directory's first pages.
  if (isValidRepoName(query) && !isRepoPinned(matches, query)) {
    sections.push({
      heading: 'Go to',
      items: [repoItem(query, 'View pull requests')],
    });
  }
  if (matches.length > 0) {
    sections.push({
      heading: 'Repositories',
      items: matches.map((repo) =>
        repoItem(repo, isRepoPinned(input.pinned, repo) ? 'Pinned' : undefined)
      ),
    });
  }
  // Each remote tier only adds repos no earlier section showed (the org
  // search caps its own results server-side).
  const added = new Set<string>();
  const takeNew = (repos: readonly string[], max = Infinity) => {
    const fresh: string[] = [];
    for (const repo of repos) {
      const key = repo.toLowerCase();
      if (
        !known.seen.has(key) &&
        !added.has(key) &&
        repo !== query &&
        fresh.length < max
      ) {
        added.add(key);
        fresh.push(repo);
      }
    }
    return fresh;
  };
  const orgMatches = takeNew(input.orgMatches);
  if (orgMatches.length > 0) {
    sections.push({
      heading: 'Your organizations',
      items: orgMatches.map((repo) => repoItem(repo)),
    });
  }
  const remote = takeNew(input.remote, MAX_REMOTE);
  if (remote.length > 0) {
    sections.push({
      heading: 'More on GitHub',
      items: remote.map((repo) => repoItem(repo)),
    });
  }
  sections.push({
    heading: 'Elsewhere',
    items: [
      {
        key: 'action:search-everywhere',
        label: `Search pull requests and URLs for “${query}”`,
        detail: 'Diff switcher',
        action: { type: 'search-everywhere' },
      },
    ],
  });
  return sections;
}
