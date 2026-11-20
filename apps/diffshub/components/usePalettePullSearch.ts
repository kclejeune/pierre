'use client';

import { useEffect, useState } from 'react';

import { searchPulls } from './githubSuggestClient';
import type { PullSearchHit } from '@/lib/diffUrlSuggestions';
import { getPatchViewerHref } from '@/lib/getPatchViewerHref';
import { readPullNumberQuery } from '@/lib/pullSearchQuery';

// How long typing pauses before the search runs, matching the palette's
// repository search.
const SEARCH_DELAY_MS = 250;
// Title words need a few characters before they narrow anything; GitHub's
// search API allows ~30 requests a minute, shared with the repo search.
const MIN_TITLE_QUERY_LENGTH = 3;
const NO_HITS: readonly PullSearchHit[] = [];

// Where the palette's pull request search looks: these repositories, or
// every one ('all'). An empty list searches nothing.
export type PullSearchRepos = readonly string[] | 'all';

interface SearchResult {
  hits: readonly PullSearchHit[];
  repos: PullSearchRepos;
  tokenVersion: number;
}

// Whether a typed query is worth a pull request search: a number ("83",
// "#83") at any length, title words from three characters. Text the
// palette already opens directly (a link, "owner/name", "owner/name#12")
// has a "Go to" row instead.
export function isPullSearchQuery(query: string): boolean {
  return (
    readPullNumberQuery(query) != null ||
    (query.length >= MIN_TITLE_QUERY_LENGTH &&
      getPatchViewerHref(query) == null)
  );
}

// The palette's top-level pull request search, for pages that offer one
// (the /pulls dashboard's scope; undefined means no search). Debounced,
// with a superseded request aborted; the previous results stay while the
// next search runs so rows don't flicker. `repos` must keep its identity
// while the scope is unchanged.
export function usePalettePullSearch(
  query: string,
  repos: PullSearchRepos | undefined,
  tokenVersion: number
): readonly PullSearchHit[] {
  const [result, setResult] = useState<SearchResult | null>(null);
  const active = repos != null && repos.length > 0 && isPullSearchQuery(query);
  useEffect(() => {
    if (!active || repos == null) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchPulls(query, repos, controller.signal).then((hits) => {
        if (!controller.signal.aborted) {
          setResult({ hits, repos, tokenVersion });
        }
      });
    }, SEARCH_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [active, query, repos, tokenVersion]);
  // Results from another scope or credential never show.
  return active &&
    result?.repos === repos &&
    result.tokenVersion === tokenVersion
    ? result.hits
    : NO_HITS;
}
