'use client';

import type { CodeViewHandle } from '@pierre/diffs/react';
import { type RefObject, useEffect, useRef, useState } from 'react';

import { incrementItemVersion } from '@/lib/incrementItemVersion';
import { isDiffItem } from '@/lib/isDiffItem';
import {
  fetchPullReviewComments,
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
  PullReviewThread,
  ViewerLoadState,
} from '@/lib/types';

interface UsePullReviewThreadsOptions {
  loadState: ViewerLoadState;
  onThreadApplied(event: DiffsHubSavedCommentEvent): void;
  pathToItemId: ReadonlyMap<string, string> | null;
  pullRequest: PullRequestRef | undefined;
  token: string;
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
  onThreadApplied,
  pathToItemId,
  pullRequest,
  token,
  viewerKey,
  viewerReadyTick,
  viewerRef,
}: UsePullReviewThreadsOptions): void {
  const [threads, setThreads] = useState<PullReviewThread[] | null>(null);
  const appliedViewerKeyRef = useRef<number | null>(null);
  const onThreadAppliedRef = useRef(onThreadApplied);
  onThreadAppliedRef.current = onThreadApplied;

  useEffect(() => {
    setThreads(null);
    appliedViewerKeyRef.current = null;
    if (pullRequest == null) {
      return;
    }

    const controller = new AbortController();
    void fetchPullReviewComments(pullRequest, token, controller.signal).then(
      (comments) => {
        if (!controller.signal.aborted) {
          setThreads(groupPullReviewThreads(comments));
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
    // it on reload so re-applied annotations are fresh.
  }, [pullRequest, token, viewerKey]);

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

    // Batch per file: each updateItem call is a synchronous layout/render
    // pass, so append all of an item's threads in one update.
    const threadsByItemId = new Map<string, PullReviewThread[]>();
    for (const thread of threads) {
      const itemId = pathToItemId.get(thread.path);
      if (itemId == null) {
        continue;
      }
      const itemThreads = threadsByItemId.get(itemId);
      if (itemThreads == null) {
        threadsByItemId.set(itemId, [thread]);
      } else {
        itemThreads.push(thread);
      }
    }

    for (const [itemId, itemThreads] of threadsByItemId) {
      const item = viewer.getItem(itemId);
      if (item == null || !isDiffItem(item)) {
        continue;
      }
      const annotations = item.annotations ?? [];
      const existingKeys = new Set(
        annotations.map((annotation) => annotation.metadata.key)
      );
      const freshThreads = itemThreads.filter(
        (thread) => !existingKeys.has(thread.key)
      );
      if (freshThreads.length === 0) {
        continue;
      }
      item.annotations = [
        ...annotations,
        ...freshThreads.map(createThreadAnnotation),
      ];
      incrementItemVersion(item);
      if (!viewer.updateItem(item)) {
        continue;
      }

      for (const thread of freshThreads) {
        onThreadAppliedRef.current(
          createThreadSavedCommentEvent(item.fileDiff, itemId, thread)
        );
      }
    }
  }, [loadState, pathToItemId, threads, viewerKey, viewerReadyTick, viewerRef]);
}
