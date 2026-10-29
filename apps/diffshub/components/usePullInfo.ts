'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { type PullRequestRef } from '@/lib/pullCommentsClient';
import {
  fetchPullInfo,
  type PullDetails,
  type PullInfo,
} from '@/lib/pullInfoClient';

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

interface UsePullInfoResult {
  pullInfo: PullInfo | null;
  // The pull's head sha, but only when the info was fetched for the current
  // viewer generation. `pullInfo` deliberately keeps the previous response
  // while a reload refetches, so its headSha can still name the old head
  // while the new diff is already interactive; anchoring review comments to
  // it would pair new line numbers with the old commit.
  viewerHeadSha: string | undefined;
  // Merges just-saved fields into the latest details without a refetch.
  mergePullDetails(pull: PullRequestRef, fields: Partial<PullDetails>): void;
}

interface PullInfoState {
  forPull: PullRequestRef;
  forViewerKey: number;
  info: PullInfo;
}

// Spreads `fields` into the state's current details (left alone when the
// response carried none), so concurrent updates each keep the others' fields.
function withDetails(
  state: PullInfoState,
  fields: Partial<PullDetails>
): PullInfoState {
  const { details } = state.info;
  return details == null
    ? state
    : { ...state, info: { ...state.info, details: { ...details, ...fields } } };
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
}: UsePullInfoOptions): UsePullInfoResult {
  // The info is stored with the pull it was fetched for: PullInfo itself
  // carries only the number, and two repos' pulls can share a number, so
  // deciding staleness needs the full owner/repo/number ref. `forViewerKey`
  // is the viewer generation whose load fetched it.
  const [state, setState] = useState<PullInfoState | null>(null);
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
        if (controller.signal.aborted) {
          return;
        }
        loadedViewerKey.current = viewerKey;
        setState({ forPull: pullRequest, forViewerKey: viewerKey, info });
        // GitHub computes mergeability lazily, and recomputes it after either
        // branch moves. When this load caught it unknown, ask again with a
        // short server-side wait and fold in just the answer, so the merge
        // controls and the Conflicts button see it.
        if (info.details?.state !== 'open' || info.details.mergeable != null) {
          return;
        }
        return fetchPullInfo(
          pullRequest,
          getGitHubToken(),
          controller.signal,
          'no-store',
          true
        ).then((settled) => {
          const mergeable = settled.details?.mergeable;
          if (
            controller.signal.aborted ||
            mergeable == null ||
            settled.headSha !== info.headSha
          ) {
            return;
          }
          // Merged into the current details, not this load's, so an edit
          // saved meanwhile survives.
          setState((current) =>
            current?.info.headSha === info.headSha
              ? withDetails(current, {
                  mergeable,
                  mergeableState: settled.details?.mergeableState ?? null,
                })
              : current
          );
        });
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
  const mergePullDetails = useCallback(
    (pull: PullRequestRef, fields: Partial<PullDetails>) => {
      // A reload fetch rewrites the browser's cached pre-edit response, so
      // later default fetches of this pull see the edit too.
      void fetchPullInfo(pull, getGitHubToken(), undefined, 'reload').catch(
        () => undefined
      );
      setState((current) =>
        current != null &&
        current.forPull.owner === pull.owner &&
        current.forPull.repo === pull.repo &&
        current.forPull.number === pull.number
          ? withDetails(current, fields)
          : current
      );
    },
    [getGitHubToken]
  );
  return {
    pullInfo: state?.info ?? null,
    viewerHeadSha:
      state?.forViewerKey === viewerKey ? state.info.headSha : undefined,
    mergePullDetails,
  };
}
