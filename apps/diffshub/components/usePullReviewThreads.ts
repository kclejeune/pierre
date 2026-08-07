'use client';

import type { CodeViewHandle } from '@pierre/diffs/react';
import { type RefObject, useEffect, useRef, useState } from 'react';

import { applyViewerAnnotations } from '@/lib/applyViewerAnnotations';
import {
  fetchPullComments,
  type PullRequestRef,
} from '@/lib/pullCommentsClient';
import {
  createThreadAnnotation,
  groupPullReviewThreads,
} from '@/lib/pullReviewThreads';
import { createThreadSavedCommentEvent } from '@/lib/savedCommentEvent';
import type {
  CommentMetadata,
  DiffsHubSavedCommentEvent,
  PullDiscussionComment,
  PullReviewThread,
  ViewerLoadState,
} from '@/lib/types';

interface UsePullReviewThreadsOptions {
  loadState: ViewerLoadState;
  // Receives the PR-level conversation (issue comments, review summaries)
  // whenever the comment fetch resolves, for the sidebar's discussion section.
  onDiscussionLoaded(discussion: PullDiscussionComment[]): void;
  onThreadApplied(event: DiffsHubSavedCommentEvent): void;
  pathToItemId: ReadonlyMap<string, string> | null;
  pullRequest: PullRequestRef | undefined;
  // Bumped after writes that create comments outside the annotation flow
  // (review submission), to refetch and inject the fresh threads.
  refreshTick?: number;
  token: string;
  // False until the stored token has been read after mount. Gating the fetch
  // on it avoids issuing (and aborting) an anonymous request that the token
  // hydration would immediately supersede.
  tokenHydrated: boolean;
  viewerKey: number;
  // Bumped by the parent whenever the CodeView handle mounts, so application
  // can retry once the viewer exists.
  viewerReadyTick: number;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
}

// Loads the pull request's review comments, groups them into threads, and
// injects each thread as an annotation on the matching file item once the
// viewer has finished loading. Threads apply exactly once per viewer
// generation (viewerKey); a reload rebuilds the items and re-applies.
export function usePullReviewThreads({
  loadState,
  onDiscussionLoaded,
  onThreadApplied,
  pathToItemId,
  pullRequest,
  refreshTick = 0,
  token,
  tokenHydrated,
  viewerKey,
  viewerReadyTick,
  viewerRef,
}: UsePullReviewThreadsOptions): void {
  const [threads, setThreads] = useState<PullReviewThread[] | null>(null);
  const appliedViewerKeyRef = useRef<number | null>(null);
  const onThreadAppliedRef = useRef(onThreadApplied);
  onThreadAppliedRef.current = onThreadApplied;
  const onDiscussionLoadedRef = useRef(onDiscussionLoaded);
  onDiscussionLoadedRef.current = onDiscussionLoaded;

  useEffect(() => {
    setThreads(null);
    appliedViewerKeyRef.current = null;
    if (pullRequest == null || !tokenHydrated) {
      return;
    }

    const controller = new AbortController();
    void fetchPullComments(pullRequest, token, controller.signal).then(
      ({ comments, discussion }) => {
        if (!controller.signal.aborted) {
          setThreads(groupPullReviewThreads(comments));
          onDiscussionLoadedRef.current(discussion);
        }
      },
      () => {
        // Thread loading is best-effort: the diff is fully usable without
        // review comments (e.g. anonymous rate-limited requests).
      }
    );
    return () => {
      controller.abort();
    };
    // token re-runs the fetch when the user signs in/out; viewerKey re-runs
    // it on reload so re-applied annotations are fresh; refreshTick re-runs
    // it after a review submission. Resetting appliedViewerKeyRef above lets
    // the apply effect run again — already-injected threads are deduped by
    // key, so only the fresh ones land.
  }, [pullRequest, refreshTick, token, tokenHydrated, viewerKey]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (
      threads == null ||
      threads.length === 0 ||
      pathToItemId == null ||
      viewer == null ||
      loadState !== 'ready' ||
      appliedViewerKeyRef.current === viewerKey
    ) {
      return;
    }
    appliedViewerKeyRef.current = viewerKey;

    applyViewerAnnotations(viewer, pathToItemId, threads, {
      createAnnotation: createThreadAnnotation,
      getKey: (thread) => thread.key,
      getPath: (thread) => thread.path,
      onApplied: (fileDiff, itemId, thread) =>
        onThreadAppliedRef.current(
          createThreadSavedCommentEvent(fileDiff, itemId, thread)
        ),
    });
  }, [loadState, pathToItemId, threads, viewerKey, viewerReadyTick, viewerRef]);
}
