'use client';

import { storedGitHubTokenHeaders } from './githubSession';
import type { PullSuggestion } from '@/lib/diffUrlSuggestions';
import { splitRepoName } from '@/lib/pinnedRepos';
import { fetchReportingRejection } from '@/lib/rejectedCredential';

// Client calls to /api/github-suggest, the command palette's GitHub-backed
// lookups. Successful responses are cached privately by the browser
// according to the route's response headers, so repeating a query is free.

function fetchSuggestPayload(params: Record<string, string>): Promise<unknown> {
  const search = new URLSearchParams(params);
  return fetchReportingRejection(`/api/github-suggest?${search}`, {
    headers: storedGitHubTokenHeaders(),
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
