'use client';

import { useEffect, useState } from 'react';

import { storedGitHubTokenHeaders } from './useGitHubToken';
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

// Suggestion payloads keyed by query so repeated keystrokes reuse in-flight
// or completed lookups; a failed load caches as null until the page reloads.
const suggestCache = new Map<string, Promise<unknown>>();

// Fetches /api/github-suggest with the given params, deduped through
// suggestCache. Resolves the parsed JSON payload, or null on any failure.
function fetchSuggestPayload(params: Record<string, string>): Promise<unknown> {
  const search = new URLSearchParams(params);
  const cacheKey = search.toString();
  let pending = suggestCache.get(cacheKey);
  if (pending == null) {
    pending = fetch(`/api/github-suggest?${search}`, {
      headers: storedGitHubTokenHeaders(),
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    suggestCache.set(cacheKey, pending);
  }
  return pending;
}

// Exported for the command palette, which shares the URL bar's progressive
// repo → pull-request suggestion flow (and its request cache).
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
// debounced; PR filtering reuses the cached list per repo.
export function useDiffUrlSuggestions(input: string): DiffUrlSuggestion[] {
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
  }, [input]);

  return suggestions;
}
