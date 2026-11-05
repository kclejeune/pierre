'use client';

import { useEffect, useRef, useState } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import type {
  PullAudience,
  PullsPage,
  PullSummary,
  ReviewRequestScope,
} from '@/lib/githubPullSummaries';
import { requestJSON } from '@/lib/pullCommentsClient';

// One /pulls list: who is involved, which repositories (none means every
// repository the search can see), and the query bar's GitHub search text.
// reviewRequests: 'teams' widens the review-request term; the dashboard only
// passes it when that term is part of the search.
export interface PullSearchRequest {
  involves: PullAudience;
  repos: readonly string[];
  reviewRequests?: ReviewRequestScope;
  text: string;
}

export interface DashboardPullsState {
  error: Error | null;
  hasMore: boolean;
  // True while the first page is in flight, whether or not rows are showing.
  loading: boolean;
  loadingMore: boolean;
  loadMore(): void;
  pulls: PullSummary[];
  // Repeats whichever request produced `error` (the first-page fetch or a
  // load-more), or refetches the first page when nothing failed. Rows on
  // screen can come from the cache with a next page, so whether more pages
  // exist says nothing about which request failed.
  retry(): void;
  totalCount: number;
}

// Doubles as the effect's dependency key and the query string.
function buildPullSearchParams(request: PullSearchRequest): URLSearchParams {
  const params = new URLSearchParams();
  params.set(
    'involves',
    request.involves === 'anyone' ? 'anyone' : request.involves.join(',')
  );
  if (request.reviewRequests === 'teams') {
    params.set('requests', 'teams');
  }
  if (request.repos.length > 0) {
    params.set('repos', request.repos.join(','));
  }
  params.set('q', request.text.trim());
  return params;
}

interface CachedPulls {
  nextCursor?: string;
  pulls: PullSummary[];
  totalCount: number;
}

// Last rows per list (every page loaded so far), so revisiting a scope or
// filter renders instantly while it revalidates. The route is
// browser-cached for 30s; this only removes the loading flash.
const MAX_CACHED_SEARCHES = 40;
const pullsCache = new Map<string, CachedPulls>();

function rememberPulls(key: string, value: CachedPulls): void {
  pullsCache.delete(key);
  pullsCache.set(key, value);
  if (pullsCache.size > MAX_CACHED_SEARCHES) {
    const oldest = pullsCache.keys().next().value;
    if (oldest != null) {
      pullsCache.delete(oldest);
    }
  }
}

function fetchPullsPage(
  search: string,
  cursor: string | undefined,
  signal: AbortSignal
): Promise<PullsPage> {
  const query =
    cursor == null ? search : `${search}&cursor=${encodeURIComponent(cursor)}`;
  return requestJSON(`/api/github-pulls?${query}`, {
    headers: storedGitHubTokenHeaders(),
    signal,
  }) as Promise<PullsPage>;
}

interface SearchState extends CachedPulls {
  // The last failed request's error, and whether it was the first-page
  // fetch or a load-more.
  failure: { error: Error; request: 'first' | 'more' } | null;
  // The cacheKey this state belongs to; a mismatch re-derives it from the
  // cache.
  key: string;
  loading: boolean;
  loadingMore: boolean;
}

function initialSearchState(key: string): SearchState {
  const cached = pullsCache.get(key);
  return {
    failure: null,
    key,
    loading: true,
    loadingMore: false,
    nextCursor: cached?.nextCursor,
    pulls: cached?.pulls ?? [],
    totalCount: cached?.totalCount ?? 0,
  };
}

// The rows for one /pulls list, a page at a time. Callers mount only after
// token hydration, so the request always carries the right identity.
// Revalidating a cached list refetches its first page only; extra pages
// loaded earlier are dropped rather than shown stale under fresh ones.
export function useDashboardPulls(
  request: PullSearchRequest,
  tokenVersion: number
): DashboardPullsState {
  const search = buildPullSearchParams(request).toString();
  const cacheKey = `${tokenVersion}:${search}`;

  const [storedState, setState] = useState(() => initialSearchState(cacheKey));
  const [reloadVersion, setReloadVersion] = useState(0);
  // On a search change, render the new search's cached rows this pass.
  const state =
    storedState.key === cacheKey ? storedState : initialSearchState(cacheKey);
  // The in-flight "load more", aborted when the search changes under it.
  const moreController = useRef<AbortController | null>(null);

  // Aborts on cleanup rather than only ignoring the result, so typing a new
  // search or toggling chips quickly doesn't leave superseded searches
  // running upstream.
  useEffect(() => {
    const controller = new AbortController();
    setState((previous) =>
      previous.key === cacheKey
        ? { ...previous, failure: null, loading: true }
        : initialSearchState(cacheKey)
    );
    fetchPullsPage(search, undefined, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) {
          return;
        }
        const value: CachedPulls = {
          nextCursor: page.nextCursor,
          pulls: page.pulls,
          totalCount: page.totalCount ?? page.pulls.length,
        };
        rememberPulls(cacheKey, value);
        setState({
          ...value,
          failure: null,
          key: cacheKey,
          loading: false,
          loadingMore: false,
        });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) {
          // Keep any cached rows on screen; the error renders beneath them.
          setState((previous) => ({
            ...previous,
            failure: { error, request: 'first' },
            key: cacheKey,
            loading: false,
          }));
        }
      });
    return () => {
      controller.abort();
      moreController.current?.abort();
      moreController.current = null;
    };
  }, [cacheKey, reloadVersion, search]);

  const loadMore = () => {
    const cursor = state.nextCursor;
    if (cursor == null || state.loading || moreController.current != null) {
      return;
    }
    const controller = new AbortController();
    moreController.current = controller;
    setState((previous) => ({
      ...previous,
      failure: null,
      loadingMore: true,
    }));
    fetchPullsPage(search, cursor, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) {
          return;
        }
        setState((previous) => {
          // GitHub search pages can overlap when rows are updated between
          // requests (an update moves a pull back to the top); keep the
          // first copy.
          const seen = new Set(previous.pulls.map(pullKey));
          const value: CachedPulls = {
            nextCursor: page.nextCursor,
            pulls: [
              ...previous.pulls,
              ...page.pulls.filter((pull) => !seen.has(pullKey(pull))),
            ],
            totalCount: page.totalCount ?? previous.totalCount,
          };
          rememberPulls(previous.key, value);
          return { ...previous, ...value, loadingMore: false };
        });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) {
          setState((previous) => ({
            ...previous,
            failure: { error, request: 'more' },
            loadingMore: false,
          }));
        }
      })
      .finally(() => {
        if (moreController.current === controller) {
          moreController.current = null;
        }
      });
  };

  return {
    error: state.failure?.error ?? null,
    hasMore: state.nextCursor != null,
    loading: state.loading,
    loadingMore: state.loadingMore,
    loadMore,
    pulls: state.pulls,
    retry: () =>
      state.failure?.request === 'more'
        ? loadMore()
        : setReloadVersion((version) => version + 1),
    totalCount: state.totalCount,
  };
}

export function pullKey(pull: PullSummary): string {
  return `${pull.owner}/${pull.repo}#${pull.number}`;
}
