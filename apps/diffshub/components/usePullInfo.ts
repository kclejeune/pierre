'use client';

import { useEffect, useState } from 'react';

import { type PullRequestRef } from '@/lib/pullCommentsClient';
import { fetchPullInfo, type PullInfo } from '@/lib/pullInfoClient';

interface UsePullInfoOptions {
  getGitHubToken(): string | undefined;
  // Bumped when the saved token changes, so a newly saved token retries a
  // pull that was invisible anonymously.
  githubTokenVersion: number;
  pullRequest: PullRequestRef | undefined;
  // False until the stored token has been read after mount; fetching before
  // that would issue an anonymous request the hydrated token supersedes.
  tokenHydrated: boolean;
  // Bumped per loaded diff generation so a reload re-reads the pull (its
  // branches can be retargeted while the tab is open).
  viewerKey: number;
}

// Loads the pull request's title and base/head branches for the viewer
// chrome. Best-effort: a failure just leaves the branch display empty, the
// diff itself is unaffected.
export function usePullInfo({
  getGitHubToken,
  githubTokenVersion,
  pullRequest,
  tokenHydrated,
  viewerKey,
}: UsePullInfoOptions): PullInfo | null {
  const [pullInfo, setPullInfo] = useState<PullInfo | null>(null);
  useEffect(() => {
    // Keep the current value while the same pull refetches (a reload or token
    // change) so the header's branch display does not blink; only a different
    // pull, or none, clears it.
    setPullInfo((current) =>
      current?.number === pullRequest?.number ? current : null
    );
    if (pullRequest == null || !tokenHydrated) {
      return;
    }
    const controller = new AbortController();
    fetchPullInfo(pullRequest, getGitHubToken(), controller.signal)
      .then((info) => {
        if (!controller.signal.aborted) {
          setPullInfo(info);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [
    getGitHubToken,
    githubTokenVersion,
    pullRequest,
    tokenHydrated,
    viewerKey,
  ]);
  return pullInfo;
}
