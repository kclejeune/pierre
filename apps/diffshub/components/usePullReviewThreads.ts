'use client';

import type { CodeViewHandle } from '@pierre/diffs/react';
import { type RefObject, useEffect, useRef, useState } from 'react';

import { classifyCommentLineType } from '@/lib/classifyCommentLineType';
import { isDiffItem } from '@/lib/isDiffItem';
import {
  fetchPullReviewComments,
  type PullRequestRef,
} from '@/lib/pullCommentsClient';
import { groupPullReviewThreads } from '@/lib/pullReviewThreads';
import type {
  CommentMetadata,
  DiffsHubSavedCommentEvent,
  PullReviewThread,
  ViewerLoadState,
} from '@/lib/types';

interface UsePullReviewThreadsOptions {
  getToken(): string | undefined;
  loadState: ViewerLoadState;
  onThreadApplied(event: DiffsHubSavedCommentEvent): void;
  pathToItemId: ReadonlyMap<string, string> | null;
  pullRequest: PullRequestRef | null;
  tokenVersion: number | string;
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
  getToken,
  loadState,
  onThreadApplied,
  pathToItemId,
  pullRequest,
  tokenVersion,
  viewerKey,
  viewerReadyTick,
  viewerRef,
}: UsePullReviewThreadsOptions): void {
  const [threads, setThreads] = useState<PullReviewThread[] | null>(null);
  const appliedViewerKeyRef = useRef<number | null>(null);
  const onThreadAppliedRef = useRef(onThreadApplied);
  onThreadAppliedRef.current = onThreadApplied;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    setThreads(null);
    appliedViewerKeyRef.current = null;
    if (pullRequest == null) {
      return;
    }

    let cancelled = false;
    void fetchPullReviewComments(pullRequest, getTokenRef.current()).then(
      (comments) => {
        if (!cancelled) {
          setThreads(groupPullReviewThreads(comments));
        }
      },
      () => {
        // Thread loading is best-effort: the diff is fully usable without
        // review comments (e.g. anonymous rate-limited requests).
      }
    );
    return () => {
      cancelled = true;
    };
    // tokenVersion re-runs the fetch when the user signs in/out; viewerKey
    // re-runs it on reload so re-applied annotations are fresh.
  }, [pullRequest, tokenVersion, viewerKey]);

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

    for (const thread of threads) {
      const itemId = pathToItemId.get(thread.path);
      if (itemId == null) {
        continue;
      }
      const item = viewer.getItem(itemId);
      if (item == null || !isDiffItem(item)) {
        continue;
      }
      const annotations = item.annotations ?? [];
      if (
        annotations.some((annotation) => annotation.metadata.key === thread.key)
      ) {
        continue;
      }
      item.annotations = [
        ...annotations,
        {
          side: thread.side,
          lineNumber: thread.lineNumber,
          metadata: {
            kind: 'thread',
            key: thread.key,
            range: thread.range,
            thread,
          },
        },
      ];
      item.version = typeof item.version === 'number' ? item.version + 1 : 1;
      if (!viewer.updateItem(item)) {
        continue;
      }

      const root = thread.comments[0];
      onThreadAppliedRef.current({
        author: root.author,
        itemId,
        key: thread.key,
        lineNumber: thread.lineNumber,
        lineType: classifyCommentLineType(
          item.fileDiff,
          thread.side,
          thread.lineNumber
        ),
        message: root.body,
        range: thread.range,
        side: thread.side,
      });
    }
  }, [loadState, pathToItemId, threads, viewerKey, viewerReadyTick, viewerRef]);
}
