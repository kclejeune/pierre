'use client';

import type { CodeViewHandle } from '@pierre/diffs/react';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';

import { fetchReviewThreadStates } from './reviewThreadsClient';
import { applyViewerAnnotations } from '@/lib/applyViewerAnnotations';
import { isThreadAnnotation } from '@/lib/isThreadAnnotation';
import {
  fetchPullComments,
  type PullRequestRef,
} from '@/lib/pullCommentsClient';
import {
  createThreadAnnotation,
  groupPullReviewThreads,
} from '@/lib/pullReviewThreads';
import {
  applyReviewThreadStates,
  isSameReviewThreadState,
} from '@/lib/reviewThreadState';
import { createThreadSavedCommentEvent } from '@/lib/savedCommentEvent';
import type {
  CommentMetadata,
  DiffsHubSavedCommentEvent,
  PullDiscussionComment,
  PullReviewThread,
  PullReviewThreadState,
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
  viewerRef: RefObject<CodeViewHandle<CommentMetadata, undefined> | null>;
}

// Loads the pull request's review comments, groups them into threads, and
// injects each thread as an annotation on the matching file item once the
// viewer has finished loading. Threads' resolution status loads separately
// (GraphQL, token only) so the comments don't wait on it; when it arrives,
// or changes on a refetch, it is merged into cards already in the diff.
// Re-applies after every fetch: already-injected threads are deduped by key,
// so only new threads and changed states land.
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
  const [threadStates, setThreadStates] = useState<ReadonlyMap<
    number,
    PullReviewThreadState
  > | null>(null);
  // The thread list last injected, so the apply effect runs once per change
  // to it rather than on every viewer tick.
  const appliedThreadsRef = useRef<PullReviewThread[] | null>(null);
  const onThreadAppliedRef = useRef(onThreadApplied);
  onThreadAppliedRef.current = onThreadApplied;
  const onDiscussionLoadedRef = useRef(onDiscussionLoaded);
  onDiscussionLoadedRef.current = onDiscussionLoaded;

  useEffect(() => {
    setThreads(null);
    setThreadStates(null);
    appliedThreadsRef.current = null;
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
    if (token !== '') {
      void fetchReviewThreadStates(pullRequest, token, controller.signal).then(
        (states) => {
          if (!controller.signal.aborted) {
            setThreadStates(states);
          }
        },
        () => {
          // Best-effort too: without states threads render open and
          // unresolvable.
        }
      );
    }
    return () => {
      controller.abort();
    };
    // token re-runs the fetch when the user signs in/out; viewerKey re-runs
    // it on reload so re-applied annotations are fresh; refreshTick re-runs
    // it after a review submission.
  }, [pullRequest, refreshTick, token, tokenHydrated, viewerKey]);

  const statefulThreads = useMemo(
    () =>
      threads == null || threadStates == null
        ? threads
        : applyReviewThreadStates(threads, threadStates),
    [threadStates, threads]
  );

  useEffect(() => {
    const viewer = viewerRef.current;
    if (
      statefulThreads == null ||
      statefulThreads.length === 0 ||
      pathToItemId == null ||
      viewer == null ||
      loadState !== 'ready' ||
      appliedThreadsRef.current === statefulThreads
    ) {
      return;
    }
    appliedThreadsRef.current = statefulThreads;

    applyViewerAnnotations(viewer, pathToItemId, statefulThreads, {
      // A card already in the diff keeps its comments (it may hold replies
      // posted since this fetch) and takes the fetched state.
      createAnnotation: (thread, fileDiff, existing) =>
        existing != null && isThreadAnnotation(existing)
          ? {
              ...existing,
              metadata: {
                ...existing.metadata,
                thread: { ...existing.metadata.thread, state: thread.state },
              },
            }
          : createThreadAnnotation(thread, fileDiff),
      getKey: (thread) => thread.key,
      getPath: (thread) => thread.path,
      // Only a fetched state replaces a card's; a refetch that couldn't read
      // states leaves the ones cards already show.
      isStale: (thread, annotation) =>
        isThreadAnnotation(annotation) &&
        thread.state != null &&
        !isSameReviewThreadState(
          thread.state,
          annotation.metadata.thread.state
        ),
      onApplied: (fileDiff, itemId, _thread, annotation) =>
        onThreadAppliedRef.current(
          createThreadSavedCommentEvent(
            fileDiff,
            itemId,
            annotation.metadata.thread
          )
        ),
    });
  }, [
    loadState,
    pathToItemId,
    statefulThreads,
    viewerKey,
    viewerReadyTick,
    viewerRef,
  ]);
}
