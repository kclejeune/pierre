'use client';

import { useEffect, useState } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
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
  // A repo card: scoped to the dashboard's active bucket tab when one is
  // given, every open pull in the repo otherwise.
  | { kind: 'repo'; repo: string; bucket?: PullBucket };

interface PullsPayload {
  pulls: PullSummary[];
  totalCount?: number;
  error?: string;
}

function fetchPulls(search: string): Promise<PullsPayload> {
  return fetch(`/api/github-pulls?${search}`, {
    headers: storedGitHubTokenHeaders(),
  }).then(async (response) => {
    const payload = (await response.json()) as PullsPayload;
    if (!response.ok) {
      throw new Error(
        payload.error ?? `GitHub request failed (${response.status}).`
      );
    }
    return payload;
  });
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

  // Doubles as the effect's dependency key and the query string.
  const params = new URLSearchParams();
  if (source.bucket != null) {
    params.set('bucket', source.bucket);
  }
  if (source.kind === 'repo') {
    params.set('repo', source.repo);
  } else if ((source.excludeRepos ?? []).length > 0) {
    params.set('exclude', (source.excludeRepos ?? []).join(','));
  }
  const sourceKey = params.toString();

  useEffect(() => {
    let cancelled = false;
    setState((previous) => ({ ...previous, error: null, loading: true }));
    fetchPulls(sourceKey)
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
