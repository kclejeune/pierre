'use client';

import { storedGitHubTokenHeaders } from './githubSession';
import type { PullSearchHit, PullSuggestion } from '@/lib/diffUrlSuggestions';
import { splitRepoName } from '@/lib/pinnedRepos';
import { fetchReportingRejection } from '@/lib/rejectedCredential';

// Client calls to /api/github-suggest, the command palette's GitHub-backed
// lookups. Successful responses are cached privately by the browser
// according to the route's response headers, so repeating a query is free.

function fetchSuggestPayload(
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const search = new URLSearchParams(params);
  return fetchReportingRejection(`/api/github-suggest?${search}`, {
    headers: storedGitHubTokenHeaders(),
    signal,
  })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
}

// GitHub's repository-name search: `query` in `owner`'s repositories when an
// owner is given, across GitHub otherwise. Empty on any failure.
export async function searchGitHubRepos(
  owner: string | null,
  query: string
): Promise<string[]> {
  const payload = (await fetchSuggestPayload({
    kind: 'repos',
    owner: owner ?? '',
    q: query,
  })) as { repos?: string[] } | null;
  return payload?.repos ?? [];
}

// A repository's open pull requests (GitHub's first 30), or null when the
// request failed.
export async function loadOpenPulls(
  repo: string
): Promise<PullSuggestion[] | null> {
  const { owner, repo: name } = splitRepoName(repo);
  const payload = (await fetchSuggestPayload({
    kind: 'pulls',
    owner,
    repo: name,
  })) as { pulls?: PullSuggestion[] } | null;
  return payload?.pulls ?? null;
}

// Pull requests in any state matching `query` (a number, "#123", or title
// words) within `repos`, or every repository the viewer can see for 'all'.
// Empty on any failure. `signal` drops a superseded search.
export async function searchPulls(
  query: string,
  repos: readonly string[] | 'all',
  signal?: AbortSignal
): Promise<PullSearchHit[]> {
  const params: Record<string, string> = { kind: 'pull-search', q: query };
  if (repos !== 'all') {
    params.repos = repos.join(',');
  }
  const payload = (await fetchSuggestPayload(params, signal)) as {
    pulls?: PullSearchHit[];
  } | null;
  return payload?.pulls ?? [];
}
