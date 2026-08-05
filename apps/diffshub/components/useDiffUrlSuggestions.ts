'use client';

import { useEffect, useState } from 'react';

import { readStoredGitHubToken } from './useGitHubToken';
import {
  deriveSuggestQuery,
  filterPullSuggestions,
  type PullSuggestion,
  type SuggestQuery,
} from '@/lib/diffUrlSuggestions';

export interface DiffUrlSuggestion {
  key: string;
  label: string;
  // Input text the suggestion fills in when accepted. Pull suggestions also
  // carry the viewer path to navigate to directly.
  fill: string;
  href?: string;
}

// Open-PR lists keyed by repo so keystrokes after "owner/repo#" filter
// client-side instead of refetching; a failed load caches as [] until the
// page reloads.
const pullsByRepo = new Map<string, Promise<PullSuggestion[]>>();

function authHeaders(): HeadersInit {
  const token = readStoredGitHubToken();
  return token === '' ? {} : { Authorization: `Bearer ${token}` };
}

function fetchPulls(owner: string, repo: string): Promise<PullSuggestion[]> {
  const cacheKey = `${owner}/${repo}`;
  let pending = pullsByRepo.get(cacheKey);
  if (pending == null) {
    const params = new URLSearchParams({ kind: 'pulls', owner, repo });
    pending = fetch(`/api/github-suggest?${params}`, {
      headers: authHeaders(),
    })
      .then(async (response) => {
        if (!response.ok) {
          return [];
        }
        const payload = (await response.json()) as {
          pulls?: PullSuggestion[];
        };
        return payload.pulls ?? [];
      })
      .catch(() => []);
    pullsByRepo.set(cacheKey, pending);
  }
  return pending;
}

async function loadSuggestions(
  query: SuggestQuery
): Promise<DiffUrlSuggestion[]> {
  if (query.kind === 'repos') {
    const params = new URLSearchParams({
      kind: 'repos',
      owner: query.owner ?? '',
      q: query.query,
    });
    const response = await fetch(`/api/github-suggest?${params}`, {
      headers: authHeaders(),
    }).catch(() => null);
    if (response == null || !response.ok) {
      return [];
    }
    const payload = (await response.json()) as { repos?: string[] };
    return (payload.repos ?? []).map((fullName) => ({
      key: `repo:${fullName}`,
      label: fullName,
      // The trailing "#" keeps the flow going: the next suggestion pass
      // offers the repo's open pull requests.
      fill: `${fullName}#`,
    }));
  }

  const pulls = filterPullSuggestions(
    await fetchPulls(query.owner, query.repo),
    query.filter
  );
  return pulls.slice(0, 8).map((pull) => ({
    key: `pull:${pull.number}`,
    label: `#${pull.number} · ${pull.title}`,
    fill: `${query.owner}/${query.repo}#${pull.number}`,
    href: `/${query.owner}/${query.repo}/pull/${pull.number}`,
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
