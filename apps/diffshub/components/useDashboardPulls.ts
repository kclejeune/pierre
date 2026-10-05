'use client';

import { useEffect, useState } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import type {
  PullBucket,
  PullSummary,
  ReviewRequestScope,
} from '@/lib/githubPullSummaries';
import { requestJSON } from '@/lib/pullCommentsClient';

export interface DashboardPullsState {
  error: Error | null;
  // True while a request is in flight, whether or not rows are showing.
  loading: boolean;
  pulls: PullSummary[];
  retry(): void;
  totalCount: number;
}

// reviewRequests: 'teams' widens the bucket's review-request qualifier; the
// dashboard only passes it for buckets that have one.
export type DashboardPullsSource =
  // The main bucket list; excludeRepos drops pulls from repos already shown
  // in the pinned cards above it.
  | {
      kind: 'bucket';
      bucket: PullBucket;
      excludeRepos?: readonly string[];
      reviewRequests?: ReviewRequestScope;
    }
  // A repo card: scoped to the dashboard's active bucket tab when one is
  // given, every open pull in the repo otherwise.
  | {
      kind: 'repo';
      repo: string;
      bucket?: PullBucket;
      reviewRequests?: ReviewRequestScope;
    };

interface PullsPayload {
  pulls: PullSummary[];
  totalCount?: number;
}

interface CachedPulls {
  pulls: PullSummary[];
  totalCount: number;
}

// Last rows per section, so revisiting a tab or repo card renders instantly
// while it revalidates. The route is browser-cached for 30s; this only removes
// the loading flash.
const MAX_CACHED_SECTIONS = 40;
const pullsCache = new Map<string, CachedPulls>();

function rememberPulls(key: string, value: CachedPulls): void {
  pullsCache.delete(key);
  pullsCache.set(key, value);
  if (pullsCache.size > MAX_CACHED_SECTIONS) {
    const oldest = pullsCache.keys().next().value;
    if (oldest != null) {
      pullsCache.delete(oldest);
    }
  }
}

function fetchPulls(search: string): Promise<PullsPayload> {
  return requestJSON(`/api/github-pulls?${search}`, {
    headers: storedGitHubTokenHeaders(),
  }) as Promise<PullsPayload>;
}

interface SectionState extends CachedPulls {
  error: Error | null;
  // The cacheKey this state belongs to; a mismatch re-derives it from the
  // cache.
  key: string;
  loading: boolean;
}

function initialSectionState(key: string): SectionState {
  const cached = pullsCache.get(key);
  return {
    error: null,
    key,
    loading: true,
    pulls: cached?.pulls ?? [],
    totalCount: cached?.totalCount ?? 0,
  };
}

// Pull request rows for one dashboard section. Callers mount only after
// token hydration, so the request always carries the right identity.
export function useDashboardPulls(
  source: DashboardPullsSource,
  tokenVersion: number
): DashboardPullsState {
  // Doubles as the effect's dependency key and the query string.
  const params = new URLSearchParams();
  if (source.bucket != null) {
    params.set('bucket', source.bucket);
    if (source.reviewRequests === 'teams') {
      params.set('requests', 'teams');
    }
  }
  if (source.kind === 'repo') {
    params.set('repo', source.repo);
  } else if ((source.excludeRepos ?? []).length > 0) {
    params.set('exclude', (source.excludeRepos ?? []).join(','));
  }
  const sourceKey = params.toString();
  const cacheKey = `${tokenVersion}:${sourceKey}`;

  const [storedState, setState] = useState(() => initialSectionState(cacheKey));
  const [reloadVersion, setReloadVersion] = useState(0);
  // On a source change, render the new source's cached rows this pass.
  const state =
    storedState.key === cacheKey ? storedState : initialSectionState(cacheKey);

  useEffect(() => {
    let cancelled = false;
    setState((previous) =>
      previous.key === cacheKey
        ? { ...previous, error: null, loading: true }
        : initialSectionState(cacheKey)
    );
    fetchPulls(sourceKey)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        const value = {
          pulls: payload.pulls,
          totalCount: payload.totalCount ?? payload.pulls.length,
        };
        rememberPulls(cacheKey, value);
        setState({
          ...value,
          error: null,
          key: cacheKey,
          loading: false,
        });
      })
      .catch((error: Error) => {
        if (!cancelled) {
          // Keep any cached rows on screen; the error renders beneath them.
          setState((previous) => ({
            ...previous,
            error,
            key: cacheKey,
            loading: false,
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, reloadVersion, sourceKey]);

  return {
    error: state.error,
    loading: state.loading,
    pulls: state.pulls,
    retry: () => setReloadVersion((version) => version + 1),
    totalCount: state.totalCount,
  };
}
