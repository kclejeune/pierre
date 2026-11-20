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
  anchorReviewThreads,
  createThreadAnnotation,
  groupReviewCommentsByRoot,
} from '@/lib/pullReviewThreads';
import {
  describeReviewThreadsLoad,
  type PullReviewThreadsLoad,
} from '@/lib/reviewThreadsLoad';
import {
  applyReviewThreadStates,
  isSameReviewThreadState,
} from '@/lib/reviewThreadState';
import { createThreadSavedCommentEvent } from '@/lib/savedCommentEvent';
import type {
  CommentMetadata,
  DiffsHubSavedCommentEvent,
  PullDiscussionComment,
  PullReviewComment,
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
// so only new threads and changed states land. Returns how far loading has
// got, with counts for threads that can't be shown (see
// PullReviewThreadsLoad), and those threads themselves (`detachedThreads`,
// each its root comment then replies) with the fetched resolution states,
// so the Comments list can show them without a card in the diff.
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
}: UsePullReviewThreadsOptions): {
  detachedThreads: readonly (readonly PullReviewComment[])[];
  load: PullReviewThreadsLoad;
  states: ReadonlyMap<number, PullReviewThreadState> | null;
} {
  // The comment fetch's outcome: null while in flight. `byRoot` holds every
  // thread's comments by root comment id, including outdated threads, which
  // `threads` leaves out because they have no current line to anchor to.
  const [fetched, setFetched] = useState<
    | {
        byRoot: ReadonlyMap<number, PullReviewComment[]>;
        threads: PullReviewThread[];
      }
    | 'failed'
    | null
  >(null);
  // The resolution request's outcome: null while in flight (or never sent,
  // without a token).
  const [fetchedStates, setFetchedStates] = useState<
    ReadonlyMap<number, PullReviewThreadState> | 'failed' | null
  >(null);
  // Set once a fetched, non-empty thread list has been injected into the
  // viewer (and so reported to the sidebar).
  const [threadsApplied, setThreadsApplied] = useState(false);
  // The thread list last injected, so the apply effect runs once per change
  // to it rather than on every viewer tick.
  const appliedThreadsRef = useRef<PullReviewThread[] | null>(null);
  const onThreadAppliedRef = useRef(onThreadApplied);
  onThreadAppliedRef.current = onThreadApplied;
  const onDiscussionLoadedRef = useRef(onDiscussionLoaded);
  onDiscussionLoadedRef.current = onDiscussionLoaded;

  useEffect(() => {
    setFetched(null);
    setFetchedStates(null);
    setThreadsApplied(false);
    appliedThreadsRef.current = null;
    if (pullRequest == null || !tokenHydrated) {
      return;
    }

    const controller = new AbortController();
    void fetchPullComments(pullRequest, token, controller.signal).then(
      ({ comments, discussion }) => {
        if (!controller.signal.aborted) {
          const byRoot = groupReviewCommentsByRoot(comments);
          setFetched({ byRoot, threads: anchorReviewThreads(byRoot) });
          onDiscussionLoadedRef.current(discussion);
        }
      },
      () => {
        // Thread loading is best-effort: the diff is fully usable without
        // review comments (e.g. anonymous rate-limited requests).
        if (!controller.signal.aborted) {
          setFetched('failed');
        }
      }
    );
    if (token !== '') {
      void fetchReviewThreadStates(pullRequest, token, controller.signal).then(
        (states) => {
          if (!controller.signal.aborted) {
            setFetchedStates(states);
          }
        },
        () => {
          // Best-effort too: without states threads render open and
          // unresolvable.
          if (!controller.signal.aborted) {
            setFetchedStates('failed');
          }
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

  const threads =
    typeof fetched === 'object' ? (fetched?.threads ?? null) : null;
  const threadStates = typeof fetchedStates === 'object' ? fetchedStates : null;
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
    setThreadsApplied(true);
  }, [
    loadState,
    pathToItemId,
    statefulThreads,
    viewerKey,
    viewerReadyTick,
    viewerRef,
  ]);

  // Threads the diff can show: grouped (so anchored to a current line or the
  // whole file) and in a file the diff contains. Derived from paths rather
  // than from onApplied, which skips threads a refetch finds already present.
  // Only read once the diff is ready: while it streams, the tree source keeps
  // adding files to this same Map in place, so its identity can't signal that
  // a thread's file has arrived (counting waits for ready anyway).
  const attachableRootIds = useMemo(
    () =>
      new Set(
        loadState !== 'ready'
          ? []
          : (threads ?? [])
              .filter((thread) => pathToItemId?.has(thread.path) === true)
              .map((thread) => thread.rootId)
      ),
    [loadState, pathToItemId, threads]
  );
  const byRoot = typeof fetched === 'object' ? (fetched?.byRoot ?? null) : null;
  const rootIds = useMemo(
    () => (byRoot == null ? null : [...byRoot.keys()]),
    [byRoot]
  );
  const threadsFailed = fetched === 'failed';
  const statesSettled = token === '' || fetchedStates != null;
  // Every input is state or memoized, so the result keeps its identity until
  // something it reports from changes.
  const load = useMemo(
    () =>
      describeReviewThreadsLoad({
        attachableRootIds,
        loadState,
        rootIds,
        states: threadStates,
        statesSettled,
        threadsApplied,
        threadsFailed,
      }),
    [
      attachableRootIds,
      loadState,
      rootIds,
      statesSettled,
      threadStates,
      threadsApplied,
      threadsFailed,
    ]
  );
  // The detached threads' comments and resolution, for the Comments list.
  const detachedThreads = useMemo(
    () =>
      load.kind !== 'ready' || byRoot == null
        ? []
        : load.detachedRootIds.flatMap((rootId) => {
            const comments = byRoot.get(rootId);
            return comments == null ? [] : [comments];
          }),
    [byRoot, load]
  );
  return useMemo(
    () => ({ detachedThreads, load, states: threadStates }),
    [detachedThreads, load, threadStates]
  );
}
