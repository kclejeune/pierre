'use client';

import { useStableCallback } from '@pierre/diffs/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { isPageShortcutEvent } from '@/lib/platform';
import type {
  DiffsHubSavedCommentEntry,
  DiffsHubSavedCommentItem,
} from '@/lib/types';

export interface CommentNavigation {
  // Index of the current thread among the ones stepping visits, or -1 before
  // any jump (and while the current thread is one stepping skips).
  position: number;
  // Threads stepping visits: unresolved ones, minus drafts when they are
  // left out.
  total: number;
  // The comment each step lands on; undefined at either end.
  previous: DiffsHubSavedCommentEntry | undefined;
  next: DiffsHubSavedCommentEntry | undefined;
  // Stable across steps, so palette commands and listeners built on them
  // don't churn.
  goPrevious(): void;
  goNext(): void;
  // Jumps to any comment (a click in the sidebar list) and makes it current,
  // so the next step continues from it.
  select(comment: DiffsHubSavedCommentEntry): void;
}

// Steps through the diff's unresolved comment threads in the order the
// sidebar's Comments tab lists them (files in diff order, threads in line
// order), with `n` and `p` as shortcuts. Resolved threads are skipped, and
// so are local drafts and pending-review comments unless `includeDrafts`.
// `reveal` scrolls the diff to a comment. Before the first step there is no
// current thread: next starts at the top and previous at the bottom.
export function useCommentNavigation(
  commentSections: readonly DiffsHubSavedCommentItem[],
  reveal: (comment: DiffsHubSavedCommentEntry) => void,
  { includeDrafts }: { includeDrafts: boolean }
): CommentNavigation {
  const comments = useMemo(
    () => commentSections.flatMap((section) => section.comments),
    [commentSections]
  );
  const isTarget = useCallback(
    (comment: DiffsHubSavedCommentEntry) =>
      comment.resolved !== true &&
      (includeDrafts || comment.reviewThread === true),
    [includeDrafts]
  );
  const targets = useMemo(
    () => comments.filter(isTarget),
    [comments, isTarget]
  );
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  // Where the current thread sits among all threads, resolved ones included,
  // so a skipped thread picked in the sidebar still anchors the next step.
  // -1 before any jump, or once the current thread is deleted, which
  // restarts stepping from the ends.
  const anchor = comments.findIndex((comment) => comment.key === currentKey);
  const position = targets.findIndex((comment) => comment.key === currentKey);
  const next =
    anchor === -1 ? targets[0] : comments.slice(anchor + 1).find(isTarget);
  const previous =
    anchor === -1
      ? targets.at(-1)
      : comments.slice(0, anchor).findLast(isTarget);

  const select = useStableCallback((comment: DiffsHubSavedCommentEntry) => {
    setCurrentKey(comment.key);
    reveal(comment);
  });
  const goPrevious = useStableCallback(() => {
    if (previous != null) {
      select(previous);
    }
  });
  const goNext = useStableCallback(() => {
    if (next != null) {
      select(next);
    }
  });

  const hasTargets = targets.length > 0;
  useEffect(() => {
    if (!hasTargets) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key !== 'n' && event.key !== 'p') ||
        !isPageShortcutEvent(event)
      ) {
        return;
      }
      event.preventDefault();
      if (event.key === 'n') {
        goNext();
      } else {
        goPrevious();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, goPrevious, hasTargets]);

  return {
    position,
    total: targets.length,
    previous,
    next,
    goPrevious,
    goNext,
    select,
  };
}
