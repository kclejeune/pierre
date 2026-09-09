'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import { requestJSON } from '@/lib/pullCommentsClient';
import {
  groupRepoDirectory,
  mergeRepoDirectoryPayload,
  type RepoDirectoryGroup,
  type RepoDirectoryPayload,
} from '@/lib/repoDirectory';

export interface RepoDirectoryState {
  error: string | null;
  groups: RepoDirectoryGroup[];
  hasMore: boolean;
  loadMore(): void;
  loading: boolean;
  loadingMore: boolean;
  refresh(): void;
}

function fetchDirectory(
  page?: number,
  cache: RequestCache = 'default'
): Promise<RepoDirectoryPayload> {
  return requestJSON(
    page == null ? '/api/github-repos' : `/api/github-repos?page=${page}`,
    {
      cache,
      headers: storedGitHubTokenHeaders(),
    }
  ) as Promise<RepoDirectoryPayload>;
}

// The viewer's org-grouped repository directory for the dashboards. Callers
// mount only when a token exists (the endpoint requires one).
export function useRepoDirectory(tokenVersion: number): RepoDirectoryState {
  const [state, setState] = useState<{
    error: string | null;
    loading: boolean;
    payload: RepoDirectoryPayload | null;
  }>({ error: null, loading: true, payload: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const forceReload = useRef(false);
  // The cache mode every page of the current listing generation is fetched
  // with. A refresh has to bypass the HTTP cache for the pages loadMore
  // fetches later too, not just page 1 — the repo route's response is cached
  // for five minutes, so a cached page 2 would merge the previous
  // generation's repos, and its nextPage cursor, into a freshly reloaded
  // page 1. Reset per generation so a token change goes back to the cache.
  const pageCache = useRef<RequestCache>('default');
  // Bumped when the listing restarts (refresh, token change) so a loadMore
  // begun beforehand discards its page instead of merging stale repos — and a
  // stale nextPage cursor — into the freshly fetched payload.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    let cancelled = false;
    setState((previous) => ({ ...previous, error: null, loading: true }));
    pageCache.current = forceReload.current ? 'reload' : 'default';
    forceReload.current = false;
    fetchDirectory(undefined, pageCache.current)
      .then((payload) => {
        if (!cancelled) {
          setState({ error: null, loading: false, payload });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setState({ error: error.message, loading: false, payload: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadVersion, tokenVersion]);

  const refresh = useCallback(() => {
    forceReload.current = true;
    // Bumped here as well as in the effect: a stale loadMore could resolve
    // in the window between this click and the effect running.
    generation.current += 1;
    setLoadingMore(false);
    setReloadVersion((version) => version + 1);
  }, []);

  const loadMore = useCallback(() => {
    const page = state.payload?.nextPage;
    if (page == null || loadingMore) {
      return;
    }
    const startedGeneration = generation.current;
    setLoadingMore(true);
    setState((previous) => ({ ...previous, error: null }));
    void fetchDirectory(page, pageCache.current).then(
      (payload) => {
        if (generation.current !== startedGeneration) {
          return;
        }
        setState((previous) => ({
          error: null,
          loading: false,
          payload:
            previous.payload == null
              ? payload
              : mergeRepoDirectoryPayload(previous.payload, payload),
        }));
        setLoadingMore(false);
      },
      (error: Error) => {
        if (generation.current !== startedGeneration) {
          return;
        }
        setState((previous) => ({
          ...previous,
          error: error.message,
          loading: false,
        }));
        setLoadingMore(false);
      }
    );
  }, [loadingMore, state.payload]);

  const groups = useMemo(
    () => (state.payload == null ? [] : groupRepoDirectory(state.payload)),
    [state.payload]
  );
  return {
    error: state.error,
    groups,
    hasMore: state.payload?.nextPage != null,
    loadMore,
    loading: state.loading,
    loadingMore,
    refresh,
  };
}
