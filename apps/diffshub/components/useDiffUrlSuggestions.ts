'use client';

import { useEffect, useState } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import { useGitHubToken } from './useGitHubToken';
import {
  deriveSuggestQuery,
  filterPullSuggestions,
  type PullSuggestion,
  type SuggestQuery,
} from '@/lib/diffUrlSuggestions';

export interface DiffUrlSuggestion {
  key: string;
  label: string;
  // Input text the suggestion fills in when accepted.
  fill: string;
}

// Fetches /api/github-suggest with the given params. Successful responses are
// cached privately by the browser according to the route's response headers.
function fetchSuggestPayload(params: Record<string, string>): Promise<unknown> {
  const search = new URLSearchParams(params);
  return fetch(`/api/github-suggest?${search}`, {
    headers: storedGitHubTokenHeaders(),
  })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
}

// Exported for the command palette, which shares the URL bar's progressive
// repo → pull-request suggestion flow.
export async function loadSuggestions(
  query: SuggestQuery
): Promise<DiffUrlSuggestion[]> {
  if (query.kind === 'repos') {
    const payload = (await fetchSuggestPayload({
      kind: 'repos',
      owner: query.owner ?? '',
      q: query.query,
    })) as { repos?: string[] } | null;
    return (payload?.repos ?? []).map((fullName) => ({
      key: `repo:${fullName}`,
      label: fullName,
      // The trailing "#" keeps the flow going: the next suggestion pass
      // offers the repo's open pull requests.
      fill: `${fullName}#`,
    }));
  }

  const payload = (await fetchSuggestPayload({
    kind: 'pulls',
    owner: query.owner,
    repo: query.repo,
  })) as { pulls?: PullSuggestion[] } | null;
  const pulls = filterPullSuggestions(payload?.pulls ?? [], query.filter);
  return pulls.slice(0, 8).map((pull) => ({
    key: `pull:${pull.number}`,
    label: `#${pull.number} · ${pull.title}`,
    fill: `${query.owner}/${query.repo}#${pull.number}`,
  }));
}

// Suggestions for the diff URL bar's current input: repository names while
// "owner/rep…" is being typed, open pull requests once a repo is complete.
// Pass '' to disable (e.g. while the input is unfocused). Repo searches are
// debounced; the suggest route's private cache headers keep repeated keystrokes
// over the same query off the network.
export function useDiffUrlSuggestions(input: string): DiffUrlSuggestion[] {
  const { tokenVersion } = useGitHubToken();
  const [suggestions, setSuggestions] = useState<DiffUrlSuggestion[]>([]);

  useEffect(() => {
    const query = deriveSuggestQuery(input);
    if (query == null) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(
      () => {
        void loadSuggestions(query).then((items) => {
          if (!cancelled) {
            setSuggestions(items);
          }
        });
      },
      query.kind === 'pulls' ? 100 : 250
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, tokenVersion]);

  return suggestions;
}
