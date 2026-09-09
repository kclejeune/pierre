'use client';

import { useEffect, useRef, useState } from 'react';

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
  // The info is stored with the pull it was fetched for: PullInfo itself
  // carries only the number, and two repos' pulls can share a number, so
  // deciding staleness needs the full owner/repo/number ref.
  const [state, setState] = useState<{
    forPull: PullRequestRef;
    info: PullInfo;
  } | null>(null);
  const loadedViewerKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    // Keep the current value while the same pull refetches (a reload or token
    // change) so the header's branch display does not blink; only a different
    // pull, or none, clears it.
    setState((current) =>
      current != null &&
      pullRequest != null &&
      current.forPull.owner === pullRequest.owner &&
      current.forPull.repo === pullRequest.repo &&
      current.forPull.number === pullRequest.number
        ? current
        : null
    );
    if (pullRequest == null || !tokenHydrated) {
      return;
    }
    const controller = new AbortController();
    // A new viewer generation represents an explicit diff reload. Bypass the
    // pull-info response cache in that case so refreshed branch tips and state
    // cannot be paired with the newly loaded patch.
    const cache =
      loadedViewerKey.current == null || loadedViewerKey.current === viewerKey
        ? 'default'
        : 'reload';
    fetchPullInfo(pullRequest, getGitHubToken(), controller.signal, cache)
      .then((info) => {
        if (!controller.signal.aborted) {
          loadedViewerKey.current = viewerKey;
          setState({ forPull: pullRequest, info });
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
  return state?.info ?? null;
}
