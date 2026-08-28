'use client';

import { useEffect, useMemo, useState } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import {
  groupRepoDirectory,
  type RepoDirectoryGroup,
  type RepoDirectoryPayload,
} from '@/lib/repoDirectory';

export interface RepoDirectoryState {
  error: string | null;
  groups: RepoDirectoryGroup[];
  loading: boolean;
}

// One directory fetch per token version: the browse and pulls pages share
// the promise, and a saved token invalidates it naturally.
const directoryCache = new Map<number, Promise<RepoDirectoryPayload>>();

function fetchDirectory(tokenVersion: number): Promise<RepoDirectoryPayload> {
  let pending = directoryCache.get(tokenVersion);
  if (pending == null) {
    pending = fetch('/api/github-repos', {
      cache: 'no-store',
      headers: storedGitHubTokenHeaders(),
    })
      .then(async (response) => {
        const payload = (await response.json()) as RepoDirectoryPayload & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(
            payload.error ?? `GitHub request failed (${response.status}).`
          );
        }
        return payload;
      })
      .catch((error: unknown) => {
        // Failures are not cached so the next mount retries.
        directoryCache.delete(tokenVersion);
        throw error instanceof Error ? error : new Error(String(error));
      });
    directoryCache.set(tokenVersion, pending);
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

  useEffect(() => {
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
  }, [tokenVersion]);

  const groups = useMemo(
    () => (state.payload == null ? [] : groupRepoDirectory(state.payload)),
    [state.payload]
  );
  return { error: state.error, groups, loading: state.loading };
}
