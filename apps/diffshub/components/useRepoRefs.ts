'use client';

import { useEffect, useState } from 'react';

import type { GitHubRepo } from '@/lib/githubDiffSource';
import { fetchRepoRefs, type RepoRefsData } from '@/lib/repoRefs';

export type RepoRefsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RepoRefsData };

// Loads a repository's ref listing for the /browse dashboard (eager) and the
// tree view's diff menu (lazy — pass enabled=false until the menu opens).
// `reloadToken` retries after an error: fetchRepoRefs caches successes, so a
// bumped token only refetches when the previous attempt failed.
export function useRepoRefs(
  repo: GitHubRepo,
  token: string | undefined,
  enabled = true,
  reloadToken = 0
): RepoRefsState {
  const [state, setState] = useState<RepoRefsState>({ kind: 'idle' });
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchRepoRefs(repo, token).then(
      (data) => {
        if (!cancelled) {
          setState({ kind: 'ready', data });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Loading the repository refs failed.',
          });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [repo, token, enabled, reloadToken]);
  return state;
}
