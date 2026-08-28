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

// Directory pages are shared per token version across the browse and pulls
// dashboards. Refresh explicitly evicts the current token's pages.
const directoryCache = new Map<string, Promise<RepoDirectoryPayload>>();

function fetchDirectory(
  tokenVersion: number,
  page?: number
): Promise<RepoDirectoryPayload> {
  const key = `${tokenVersion}|${page ?? 'initial'}`;
  let pending = directoryCache.get(key);
  if (pending == null) {
    pending = requestJSON(
      page == null ? '/api/github-repos' : `/api/github-repos?page=${page}`,
      {
        headers: storedGitHubTokenHeaders(),
      }
    )
      .then((payload) => payload as RepoDirectoryPayload)
      .catch((error: unknown) => {
        // Failures are not cached so the next mount retries.
        directoryCache.delete(key);
        throw error instanceof Error ? error : new Error(String(error));
      });
    directoryCache.set(key, pending);
  }
  return pending;
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
  // Bumped when the listing restarts (refresh, token change) so a loadMore
  // begun beforehand discards its page instead of merging stale repos — and a
  // stale nextPage cursor — into the freshly fetched payload.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    let cancelled = false;
    setState((previous) => ({ ...previous, error: null, loading: true }));
    fetchDirectory(tokenVersion)
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
    for (const key of directoryCache.keys()) {
      if (key.startsWith(`${tokenVersion}|`)) {
        directoryCache.delete(key);
      }
    }
    // Bumped here as well as in the effect: a stale loadMore could resolve
    // in the window between this click and the effect running.
    generation.current += 1;
    setLoadingMore(false);
    setReloadVersion((version) => version + 1);
  }, [tokenVersion]);

  const loadMore = useCallback(() => {
    const page = state.payload?.nextPage;
    if (page == null || loadingMore) {
      return;
    }
    const startedGeneration = generation.current;
    setLoadingMore(true);
    setState((previous) => ({ ...previous, error: null }));
    void fetchDirectory(tokenVersion, page).then(
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
  }, [loadingMore, state.payload, tokenVersion]);

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
