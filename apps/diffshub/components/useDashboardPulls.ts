'use client';

import { useEffect, useState } from 'react';

import { storedGitHubTokenHeaders } from './useGitHubToken';
import type { PullBucket, PullSummary } from '@/lib/githubPullSummaries';

export interface DashboardPullsState {
  error: string | null;
  loading: boolean;
  pulls: PullSummary[];
  totalCount: number;
}

export type DashboardPullsSource =
  // The main bucket list; excludeRepos drops pulls from repos already shown
  // in the pinned cards above it.
  | { kind: 'bucket'; bucket: PullBucket; excludeRepos?: readonly string[] }
  // A pinned repo's card, scoped to the dashboard's active bucket tab.
  | { kind: 'repo'; repo: string; bucket: PullBucket };

interface PullsPayload {
  pulls: PullSummary[];
  totalCount?: number;
  error?: string;
}

// Completed lookups keyed by source + token version so switching bucket tabs
// back and forth (or unpinning and re-pinning a repo) doesn't refetch; a new
// token version naturally invalidates everything.
const pullsCache = new Map<string, Promise<PullsPayload>>();

function fetchPulls(cacheKey: string, search: string): Promise<PullsPayload> {
  let pending = pullsCache.get(cacheKey);
  if (pending == null) {
    pending = fetch(`/api/github-pulls?${search}`, {
      headers: storedGitHubTokenHeaders(),
      cache: 'no-store',
    })
      .then(async (response) => {
        const payload = (await response.json()) as PullsPayload;
        if (!response.ok) {
          throw new Error(
            payload.error ?? `GitHub request failed (${response.status}).`
          );
        }
        return payload;
      })
      .catch((error: unknown) => {
        // Failures are not cached: a transient error should retry on the next
        // mount rather than pinning the section into an error state.
        pullsCache.delete(cacheKey);
        throw error instanceof Error ? error : new Error(String(error));
      });
    pullsCache.set(cacheKey, pending);
  }
  return pending;
}

// Pull request rows for one dashboard section. Callers mount only after
// token hydration, so the request always carries the right identity.
export function useDashboardPulls(
  source: DashboardPullsSource,
  tokenVersion: number
): DashboardPullsState {
  const [state, setState] = useState<DashboardPullsState>({
    error: null,
    loading: true,
    pulls: [],
    totalCount: 0,
  });

  const excludeRepos =
    source.kind === 'bucket' ? (source.excludeRepos ?? []) : [];
  const excludeParam =
    excludeRepos.length > 0
      ? `&exclude=${encodeURIComponent(excludeRepos.join(','))}`
      : '';
  const sourceKey =
    source.kind === 'bucket'
      ? `bucket=${encodeURIComponent(source.bucket)}${excludeParam}`
      : `bucket=${encodeURIComponent(source.bucket)}&repo=${encodeURIComponent(source.repo)}`;

  useEffect(() => {
    let cancelled = false;
    setState((previous) => ({ ...previous, error: null, loading: true }));
    fetchPulls(`${tokenVersion}|${sourceKey}`, sourceKey)
      .then((payload) => {
        if (!cancelled) {
          setState({
            error: null,
            loading: false,
            pulls: payload.pulls,
            totalCount: payload.totalCount ?? payload.pulls.length,
          });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setState({
            error: error.message,
            loading: false,
            pulls: [],
            totalCount: 0,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sourceKey, tokenVersion]);

  return state;
}
