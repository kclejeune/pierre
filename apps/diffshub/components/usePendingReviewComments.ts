'use client';

import type { DiffLineAnnotation } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { applyViewerAnnotations } from '@/lib/applyViewerAnnotations';
import {
  getPendingReviewStorageKey,
  loadPendingReviewComments,
  savePendingReviewComments,
} from '@/lib/pendingReviewStorage';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import { createLocalSavedCommentEvent } from '@/lib/savedCommentEvent';
import type {
  CommentMetadata,
  DiffsHubSavedCommentEvent,
  PendingReviewComment,
  SavedCommentMetadata,
  ViewerLoadState,
} from '@/lib/types';

interface UsePendingReviewCommentsOptions {
  loadState: ViewerLoadState;
  // Fired for every pending card recreated in the viewer, so the sidebar
  // lists restored batch entries exactly like freshly added ones.
  onRestored(event: DiffsHubSavedCommentEvent): void;
  pathToItemId: ReadonlyMap<string, string> | null;
  pullRequest: PullRequestRef | undefined;
  viewerKey: number;
  viewerReadyTick: number;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
}

interface UsePendingReviewCommentsResult {
  clearPendingReviewComments(): void;
  handlePendingReviewCommentRemoved(key: string): void;
  handlePendingReviewCommentUpserted(entry: PendingReviewComment): void;
  pendingReviewComments: ReadonlyMap<string, PendingReviewComment>;
}

// Owns the in-progress batched review: the entry map the header control
// submits, persistence to localStorage keyed by pull request, and
// re-injection of the pending cards into the viewer after a reload. GitHub
// persists pending reviews server-side, so a reviewer who reloads mid-batch
// expects the batch to survive — the map (seeded from storage once per PR) is
// the source of truth, and every viewer generation gets the cards rebuilt
// from it, the same way review threads re-apply.
export function usePendingReviewComments({
  loadState,
  onRestored,
  pathToItemId,
  pullRequest,
  viewerKey,
  viewerReadyTick,
  viewerRef,
}: UsePendingReviewCommentsOptions): UsePendingReviewCommentsResult {
  // Keyed by annotation key alone: item ids are load-scoped, so entries carry
  // only the file path and resolve their item at injection time.
  const [pendingReviewComments, setPendingReviewComments] = useState<
    ReadonlyMap<string, PendingReviewComment>
  >(new Map());
  const storageKey =
    pullRequest == null ? null : getPendingReviewStorageKey(pullRequest);
  const hydratedKeyRef = useRef<string | null>(null);
  const seededMapRef = useRef<ReadonlyMap<string, PendingReviewComment> | null>(
    null
  );
  const appliedViewerKeyRef = useRef<number | null>(null);
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;

  // Seed the batch from storage when the pull request changes. Stored keys
  // are remapped into a `restored-` namespace: draft keys are counter-based
  // per viewer instance, so a key persisted last session could collide with
  // a draft created this session.
  useEffect(() => {
    appliedViewerKeyRef.current = null;
    hydratedKeyRef.current = null;
    if (storageKey == null) {
      setPendingReviewComments(new Map());
      return;
    }
    const map = new Map<string, PendingReviewComment>();
    loadPendingReviewComments(storageKey).forEach((entry, index) => {
      const key = `restored-${index}`;
      map.set(key, { ...entry, key });
    });
    seededMapRef.current = map;
    setPendingReviewComments(map);
    hydratedKeyRef.current = storageKey;
  }, [storageKey]);

  // Persist on every change, gated on hydration so the initial empty map
  // cannot clobber a stored batch before the seed effect has run. The seeded
  // map itself is skipped — writing it back would re-serialize exactly what
  // was just read.
  useEffect(() => {
    if (
      storageKey == null ||
      hydratedKeyRef.current !== storageKey ||
      pendingReviewComments === seededMapRef.current
    ) {
      return;
    }
    savePendingReviewComments(storageKey, [...pendingReviewComments.values()]);
  }, [pendingReviewComments, storageKey]);

  // Recreate the pending cards once per viewer generation, the same way
  // review threads re-apply: reloads rebuild the items without their
  // annotations, and the batch map is what carries the cards across. Entries
  // whose file vanished from the diff (e.g. a new push) keep their text in
  // the batch; they just have no card to show.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (
      pendingReviewComments.size === 0 ||
      pathToItemId == null ||
      viewer == null ||
      loadState !== 'ready' ||
      appliedViewerKeyRef.current === viewerKey
    ) {
      return;
    }
    appliedViewerKeyRef.current = viewerKey;

    applyViewerAnnotations(
      viewer,
      pathToItemId,
      pendingReviewComments.values(),
      {
        createAnnotation: createPendingReviewAnnotation,
        getKey: (entry) => entry.key,
        getPath: (entry) => entry.path,
        onApplied: (fileDiff, itemId, _entry, annotation) =>
          onRestoredRef.current(
            createLocalSavedCommentEvent(fileDiff, itemId, annotation)
          ),
      }
    );
  }, [
    loadState,
    pathToItemId,
    pendingReviewComments,
    viewerKey,
    viewerReadyTick,
    viewerRef,
  ]);

  const handlePendingReviewCommentUpserted = useCallback(
    (entry: PendingReviewComment) => {
      setPendingReviewComments((prev) => new Map(prev).set(entry.key, entry));
    },
    []
  );
  const handlePendingReviewCommentRemoved = useCallback((key: string) => {
    setPendingReviewComments((prev) => {
      if (!prev.has(key)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);
  const clearPendingReviewComments = useCallback(() => {
    setPendingReviewComments(new Map());
  }, []);

  return {
    clearPendingReviewComments,
    handlePendingReviewCommentRemoved,
    handlePendingReviewCommentUpserted,
    pendingReviewComments,
  };
}

function createPendingReviewAnnotation(
  entry: PendingReviewComment
): DiffLineAnnotation<SavedCommentMetadata> {
  return {
    side: entry.range.endSide ?? entry.range.side ?? 'additions',
    lineNumber: entry.range.end,
    metadata: {
      kind: 'saved',
      key: entry.key,
      author: entry.author,
      message: entry.message,
      pending: true,
      range: entry.range,
    },
  };
}
