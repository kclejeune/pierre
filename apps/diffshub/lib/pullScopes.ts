// Which repositories the /pulls list searches, and how that choice and the
// rest of the page's filters round-trip through the URL. Pure apart from the
// small localStorage list of recently viewed repositories at the bottom.

import {
  isReviewRequestScope,
  parsePullInvolvements,
  type PullAudience,
  type PullInvolvement,
  type ReviewRequestScope,
} from './githubPullSummaries';
import { isValidRepoName, parseRepoList } from './pinnedRepos';
import { hasNarrowingQualifier } from './pullSearchQuery';
import { readStoredJSON, writeStoredJSON } from './storedJSON';

export type PullScope =
  // Every repository the viewer's search can see.
  | { kind: 'all' }
  // Every pinned repository at once.
  | { kind: 'pinned' }
  | { kind: 'repo'; repo: string };

const ALL_SCOPE: PullScope = { kind: 'all' };

// The query bar's starting text, matching the open-pull list the page has
// always shown. Left out of the URL.
export const DEFAULT_QUERY_TEXT = 'is:open';

// The involvement chip a scope starts on: across every repository, pulls
// involving the viewer (anything wider is all of GitHub); inside a chosen set
// of repositories, everyone's, like a repository's own pull request tab.
export function defaultAudience(scope: PullScope): PullAudience {
  return scope.kind === 'all' ? [] : 'anyone';
}

export function scopeRepos(
  scope: PullScope,
  pinned: readonly string[]
): string[] {
  switch (scope.kind) {
    case 'all':
      return [];
    case 'pinned':
      return [...pinned];
    case 'repo':
      return [scope.repo];
  }
}

export function scopesEqual(a: PullScope, b: PullScope): boolean {
  if (a.kind === 'repo' && b.kind === 'repo') {
    return a.repo.toLowerCase() === b.repo.toLowerCase();
  }
  return a.kind === b.kind;
}

// Whether "anyone" makes sense: a set of repositories narrows it, as does a
// repo:/org:/user: qualifier typed into the bar. Across all of GitHub it
// would list every open pull request anywhere.
export function audienceAnyoneAllowed(scope: PullScope, text: string): boolean {
  return scope.kind !== 'all' || hasNarrowingQualifier(text);
}

export interface PullsPageState {
  involves: PullAudience;
  // Whether review requests to the viewer's teams count; only consulted
  // when the audience includes the review-request term.
  reviewRequests: ReviewRequestScope;
  scope: PullScope;
  text: string;
}

// The audience the list actually searches: "anyone" carried over from a
// repository scope narrows to "involves me" once nothing limits the search
// to some repositories (the URL keeps the choice for when it applies again).
export function resolveAudience(state: PullsPageState): PullAudience {
  return state.involves === 'anyone' &&
    !audienceAnyoneAllowed(state.scope, state.text)
    ? []
    : state.involves;
}

// The tabs this page used to have, mapped onto the involvement chips that
// replaced them so shared ?bucket= links keep landing on the same list.
// A Map rather than an object literal: ?bucket= is user input, and keys like
// "toString" or "__proto__" would resolve to inherited properties.
const LEGACY_BUCKET_INVOLVES = new Map<string, readonly PullInvolvement[]>([
  ['created', ['authored']],
  ['review-requested', ['review-requested']],
  ['active', ['review-requested', 'reviewed', 'commented']],
  ['assigned', ['assigned']],
]);

function parseScope(params: URLSearchParams): PullScope {
  const repo = params.get('repo');
  if (repo != null && isValidRepoName(repo)) {
    return { kind: 'repo', repo };
  }
  return params.get('scope') === 'pinned' ? { kind: 'pinned' } : ALL_SCOPE;
}

// ?involves= is "anyone", "me" (every involvement, spelled out because a
// repo scope defaults to anyone), or a chip list. Missing or unreadable
// values fall back to the scope's default.
function parseAudience(
  params: URLSearchParams,
  scope: PullScope
): PullAudience {
  const raw = params.get('involves');
  if (raw == null) {
    const legacy = LEGACY_BUCKET_INVOLVES.get(params.get('bucket') ?? '');
    return legacy != null ? [...legacy] : defaultAudience(scope);
  }
  if (raw === 'anyone') {
    return 'anyone';
  }
  if (raw === 'me') {
    return [];
  }
  return parsePullInvolvements(raw) ?? defaultAudience(scope);
}

const DEFAULT_REVIEW_REQUESTS: ReviewRequestScope = 'direct';

export function readPullsPageState(search: string): PullsPageState {
  const params = new URLSearchParams(search);
  const scope = parseScope(params);
  const requests = params.get('requests');
  return {
    involves: parseAudience(params, scope),
    reviewRequests:
      requests != null && isReviewRequestScope(requests)
        ? requests
        : DEFAULT_REVIEW_REQUESTS,
    scope,
    text: params.get('q') ?? DEFAULT_QUERY_TEXT,
  };
}

function audiencesEqual(a: PullAudience, b: PullAudience): boolean {
  if (a === 'anyone' || b === 'anyone') {
    return a === b;
  }
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function serializeAudience(involves: PullAudience): string {
  if (involves === 'anyone') {
    return 'anyone';
  }
  return involves.length === 0 ? 'me' : involves.join(',');
}

// Writes the page state onto `url`'s params, leaving defaults out so a plain
// /pulls stays plain. The legacy ?bucket= is dropped once its meaning has
// moved into ?involves=.
export function writePullsPageState(url: URL, state: PullsPageState): URL {
  const next = new URL(url);
  const params = next.searchParams;
  params.delete('bucket');
  params.delete('repo');
  params.delete('scope');
  if (state.scope.kind === 'repo') {
    params.set('repo', state.scope.repo);
  } else if (state.scope.kind === 'pinned') {
    params.set('scope', 'pinned');
  }
  if (audiencesEqual(state.involves, defaultAudience(state.scope))) {
    params.delete('involves');
  } else {
    params.set('involves', serializeAudience(state.involves));
  }
  if (state.text.trim() === DEFAULT_QUERY_TEXT) {
    params.delete('q');
  } else {
    params.set('q', state.text.trim());
  }
  if (state.reviewRequests === DEFAULT_REVIEW_REQUESTS) {
    params.delete('requests');
  } else {
    params.set('requests', state.reviewRequests);
  }
  return next;
}

// Recently viewed repository scopes, most recent first, for the repo
// switcher's idle list. Device-local: unlike pins, this is history rather
// than a choice worth syncing.
const RECENT_REPOS_KEY = 'diffshub:recent-pull-repos';
const MAX_RECENT_REPOS = 6;

export function loadRecentRepos(): string[] {
  return parseRepoList(readStoredJSON(RECENT_REPOS_KEY), MAX_RECENT_REPOS);
}

export function recordRecentRepo(repo: string): void {
  const needle = repo.toLowerCase();
  writeStoredJSON(
    RECENT_REPOS_KEY,
    [
      repo,
      ...loadRecentRepos().filter((entry) => entry.toLowerCase() !== needle),
    ].slice(0, MAX_RECENT_REPOS)
  );
}
