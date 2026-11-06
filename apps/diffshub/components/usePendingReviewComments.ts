'use client';

import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { readStoredGitHubToken } from './githubSession';
import {
  addPendingComment,
  deletePendingComment,
  editPendingComment,
  fetchPendingReview,
  submitPendingReview as submitRemotePendingReview,
} from './pendingReviewClient';
import { useGitHubToken } from './useGitHubToken';
import { useGitHubUser } from './useGitHubUser';
import { useLatestValueRef } from './useLatestValueRef';
import { applyViewerAnnotations } from '@/lib/applyViewerAnnotations';
import { incrementItemVersion } from '@/lib/incrementItemVersion';
import { isDiffItem } from '@/lib/isDiffItem';
import type { RemotePendingReview } from '@/lib/pendingReview';
import { mergePendingReview, remoteDraftKey } from '@/lib/pendingReviewMerge';
import {
  getPendingReviewStorageKey,
  loadPendingReviewComments,
  savePendingReviewComments,
} from '@/lib/pendingReviewStorage';
import {
  APIRequestError,
  createCommentAnchor,
  type PullRequestRef,
  type PullReviewDraftComment,
  type PullReviewEvent,
  submitPullReview,
} from '@/lib/pullCommentsClient';
import {
  getCommentAnnotationSide,
  type GitHubCommentAnchor,
} from '@/lib/pullReviewThreads';
import {
  chooseReviewCommit,
  describeOutdatedPendingReview,
  describeStaleReviewEntries,
  describeUnsaveableReviewEntries,
  OUTDATED_PENDING_REVIEW_HINT,
} from '@/lib/reviewCommit';
import { createLocalSavedCommentEvent } from '@/lib/savedCommentEvent';
import type {
  CommentAuthor,
  CommentMetadata,
  DiffsHubDeletedCommentEvent,
  DiffsHubSavedCommentEvent,
  PendingReviewComment,
  SavedCommentMetadata,
  ViewerLoadState,
} from '@/lib/types';

interface UsePendingReviewCommentsOptions {
  loadState: ViewerLoadState;
  // Fired for every pending card removed because GitHub no longer has its
  // draft (deleted or submitted elsewhere) or because the review was
  // submitted, so the sidebar drops it too.
  onCardRemoved(event: DiffsHubDeletedCommentEvent): void;
  // Fired for every pending card recreated in the viewer, so the sidebar
  // lists restored batch entries exactly like freshly added ones.
  onRestored(event: DiffsHubSavedCommentEvent): void;
  pathToItemId: ReadonlyMap<string, string> | null;
  // The pull head the current diff shows; stamped on each new entry as the
  // commit its anchor was read from.
  pullHeadSha: string | undefined;
  pullRequest: PullRequestRef | undefined;
  viewerKey: number;
  viewerReadyTick: number;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata, undefined> | null>;
}

interface UsePendingReviewCommentsResult {
  handlePendingReviewCommentRemoved(key: string): void;
  handlePendingReviewCommentUpserted(entry: PendingReviewComment): void;
  pendingReviewComments: ReadonlyMap<string, PendingReviewComment>;
  // Submits the batch with a verdict and summary. Throws (keeping every
  // draft) when it can't: drafts on an earlier push, drafts GitHub hasn't
  // saved, or GitHub refusing the submission.
  submitPendingReview(event: PullReviewEvent, body: string): Promise<void>;
}

const UNKNOWN_AUTHOR: CommentAuthor = { avatarUrl: '', login: 'You' };

// Owns the in-progress batched review. While signed in, the viewer's pending
// review on GitHub is the source of truth: each draft added, edited, or
// deleted here is saved to it (one write at a time, in order), drafts started
// in GitHub's UI show up here, and submitting submits that review. This
// browser keeps a copy per pull request (lib/pendingReviewStorage) so drafts
// GitHub hasn't saved yet survive a reload and are saved on the next visit.
// Cards are re-injected into the viewer whenever the batch or the viewer
// changes; injection skips cards already present.
export function usePendingReviewComments({
  loadState,
  onCardRemoved,
  onRestored,
  pathToItemId,
  pullHeadSha,
  pullRequest,
  viewerKey,
  viewerReadyTick,
  viewerRef,
}: UsePendingReviewCommentsOptions): UsePendingReviewCommentsResult {
  const { hasToken, hydrated, tokenVersion } = useGitHubToken();
  const viewer = useGitHubUser();
  // Keyed by annotation key alone: item ids are load-scoped, so entries carry
  // only the file path and resolve their item at injection time.
  const [pendingReviewComments, setPendingReviewComments] = useState<
    ReadonlyMap<string, PendingReviewComment>
  >(new Map());
  // The batch as of the latest update, ahead of the render it schedules, so
  // a save queued right after an edit reads the edited text. Every update
  // goes through setEntries.
  const entriesRef = useRef(pendingReviewComments);
  const setEntries = useCallback(
    (next: ReadonlyMap<string, PendingReviewComment>) => {
      entriesRef.current = next;
      setPendingReviewComments(next);
    },
    []
  );
  const storageKey =
    pullRequest == null ? null : getPendingReviewStorageKey(pullRequest);
  // The pull request (by storage key) the batch belongs to. Set when a
  // pull's stored copy is seeded and left alone by credential changes, so it
  // gates persistence (an empty or other pull's batch never overwrites a
  // stored one) and lets a credential change keep the batch already shown.
  const ownerKeyRef = useRef<string | null>(null);
  const seededMapRef = useRef<ReadonlyMap<string, PendingReviewComment> | null>(
    null
  );
  // The pending review on GitHub: its node id and the commit its drafts are
  // pinned to, null when there is none, undefined when unknown (not loaded
  // yet, the load failed, or a write failed in a way that may mean it was
  // submitted or deleted elsewhere). Adds name a known review so the server
  // skips its lookup; submitting re-reads it regardless.
  const reviewRef = useRef<{ commitId: string; id: string } | null | undefined>(
    undefined
  );
  // Every GitHub write runs after the one before it, starting with the load,
  // so a draft is never saved twice and edits land in order.
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const callbacksRef = useLatestValueRef({ onCardRemoved, onRestored });
  const authorRef = useLatestValueRef(viewer ?? UNKNOWN_AUTHOR);
  const placementRef = useLatestValueRef({ pathToItemId, viewerRef });
  const hasTokenRef = useLatestValueRef(hasToken);

  const enqueue = useCallback((task: () => Promise<void>) => {
    const next = queueRef.current.then(task).catch(() => undefined);
    queueRef.current = next;
    return next;
  }, []);

  // Waits until no GitHub write is queued, including writes queued by the
  // ones it waited for (a save re-queues itself for an edit made meanwhile).
  const drainQueue = useCallback(async () => {
    let current: Promise<void>;
    do {
      current = queueRef.current;
      await current;
    } while (current !== queueRef.current);
  }, []);

  // The draft stays on GitHub; submitting re-reads the review, which brings
  // it back before anything is published.
  const handleDeleteFailed = useCallback((error: unknown) => {
    toastSyncError(
      'The draft could not be deleted on GitHub.',
      'It shows again before you submit, and on your next visit.',
      error
    );
  }, []);

  const updateEntry = useCallback(
    (key: string, patch: Partial<PendingReviewComment>) => {
      const entry = entriesRef.current.get(key);
      if (entry != null) {
        setEntries(
          new Map(entriesRef.current).set(key, { ...entry, ...patch })
        );
      }
    },
    [setEntries]
  );

  // Saves one draft's current state to GitHub: adds it when GitHub doesn't
  // have it, saves its text when it was edited. Drafts getDraftTarget refuses
  // stay as they are (submitting names them), and nothing is sent while
  // signed out. A draft deleted, or a pull request left, while its add was
  // in flight is deleted again on GitHub. Failures leave the draft unsaved
  // (it is retried on submit and on the next visit) and say so once.
  const saveDraft = useCallback(
    (key: string) =>
      enqueue(async () => {
        if (pullRequest == null || !hasTokenRef.current) {
          return;
        }
        // Queued before a switch to another pull request: its key may name
        // an entry of the new pull's batch.
        const pullKey = getPendingReviewStorageKey(pullRequest);
        const isGone = () =>
          ownerKeyRef.current !== pullKey || !entriesRef.current.has(key);
        const entry = entriesRef.current.get(key);
        if (isGone() || entry == null || !needsSave(entry)) {
          return;
        }
        try {
          if (entry.remoteId == null) {
            const target = getDraftTarget(entry, reviewRef.current);
            if (typeof target === 'string') {
              return;
            }
            const saved = await addPendingComment(
              pullRequest,
              target.commitId,
              reviewRef.current?.id,
              { ...target.anchor, body: entry.message }
            );
            if (isGone()) {
              await deletePendingComment(pullRequest, saved.commentId).catch(
                handleDeleteFailed
              );
              return;
            }
            reviewRef.current = {
              commitId: target.commitId,
              id: saved.reviewId,
            };
            updateEntry(key, {
              remoteId: saved.commentId,
              syncedMessage: entry.message,
            });
            // Edited while the add was in flight: save the newer text too.
            if (entriesRef.current.get(key)?.message !== entry.message) {
              void saveDraft(key);
            }
          } else {
            await editPendingComment(
              pullRequest,
              entry.remoteId,
              entry.message
            );
            if (!isGone()) {
              updateEntry(key, { syncedMessage: entry.message });
            }
          }
        } catch (error) {
          if (isGone()) {
            return;
          }
          // The cached review may have been submitted or deleted elsewhere;
          // the next add lets the server find it, and submitting re-reads it.
          if (reviewRef.current != null) {
            reviewRef.current = undefined;
          }
          if (
            error instanceof APIRequestError &&
            error.code === 'stale-review'
          ) {
            toast.error(
              "A draft comment couldn't be added to your pending review on GitHub.",
              {
                description: OUTDATED_PENDING_REVIEW_HINT,
                id: 'pending-review-stale',
              }
            );
            return;
          }
          toastSyncError(
            'A draft comment could not be saved to GitHub.',
            'It stays in this browser and is saved on your next visit.',
            error,
            'pending-review-save'
          );
        }
      }),
    // saveDraft re-enqueues itself, so it is referenced through its own
    // binding rather than a dependency.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [enqueue, handleDeleteFailed, hasTokenRef, pullRequest, updateEntry]
  );

  // Removes the viewer cards (and sidebar entries) for `entries`, batched
  // per file so each item re-renders once.
  const removeCards = useCallback(
    (entries: Iterable<PendingReviewComment>) => {
      const { pathToItemId: paths, viewerRef: ref } = placementRef.current;
      const viewerHandle = ref.current;
      const keysByItemId = new Map<string, Set<string>>();
      for (const entry of entries) {
        const itemId = paths?.get(entry.path);
        if (itemId == null) {
          continue;
        }
        const keys = keysByItemId.get(itemId) ?? new Set<string>();
        keys.add(entry.key);
        keysByItemId.set(itemId, keys);
        callbacksRef.current.onCardRemoved({ itemId, key: entry.key });
      }
      for (const [itemId, keys] of keysByItemId) {
        const item = viewerHandle?.getItem(itemId);
        if (
          viewerHandle == null ||
          item == null ||
          !isDiffItem(item) ||
          item.annotations == null
        ) {
          continue;
        }
        const next = item.annotations.filter(
          (annotation) => !keys.has(annotation.metadata.key)
        );
        if (next.length !== item.annotations.length) {
          item.annotations = next;
          incrementItemVersion(item);
          viewerHandle.updateItem(item);
        }
      }
    },
    [callbacksRef, placementRef]
  );

  // Adopts the pending review on GitHub (null when there is none) into the
  // batch, as lib/pendingReviewMerge describes, and removes the cards of
  // drafts GitHub no longer has. Resolves to whether drafts were added,
  // dropped, or given GitHub's text.
  const reconcile = useCallback(
    (remote: RemotePendingReview | null): boolean => {
      reviewRef.current =
        remote == null ? null : { commitId: remote.commitId, id: remote.id };
      const current = entriesRef.current;
      const merged = new Map(
        mergePendingReview(
          [...current.values()],
          remote,
          authorRef.current
        ).map((entry) => [entry.key, entry])
      );
      const textChanged = [...merged.values()].some(
        (entry) => current.get(entry.key)?.message !== entry.message
      );
      const changed = merged.size !== current.size || textChanged;
      // GitHub agreeing with the batch leaves it (and its cards) as is.
      if (
        changed ||
        [...merged.values()].some(
          (entry) =>
            current.get(entry.key)?.syncedMessage !== entry.syncedMessage
        )
      ) {
        removeCards(
          [...current.values()].filter((entry) => !merged.has(entry.key))
        );
        setEntries(merged);
      }
      return changed;
    },
    [authorRef, removeCards, setEntries]
  );

  // Seed the batch when the pull request or credential changes. A new pull
  // request starts from this browser's copy: stored drafts never saved to
  // GitHub get `restored-` keys (draft keys are counter-based per viewer
  // instance, so a stored one could collide with a new draft), drafts GitHub
  // has are keyed by their GitHub id. A credential change keeps the batch
  // already shown. Signed in, the batch is then reconciled with the pending
  // review on GitHub and every draft GitHub hasn't saved is saved.
  useEffect(() => {
    reviewRef.current = undefined;
    if (storageKey == null || pullRequest == null) {
      ownerKeyRef.current = null;
      setEntries(new Map());
      return;
    }
    if (ownerKeyRef.current !== storageKey) {
      const seeded = new Map(
        loadPendingReviewComments(storageKey).map((entry, index) => {
          const key =
            entry.remoteId == null
              ? `restored-${index}`
              : remoteDraftKey(entry.remoteId);
          return [key, { ...entry, key }];
        })
      );
      // Cards from the previous pull request.
      removeCards(entriesRef.current.values());
      seededMapRef.current = seeded;
      ownerKeyRef.current = storageKey;
      setEntries(seeded);
    }
    // A stored token may still be refreshing; the load waits for it.
    if (!hasToken || !hydrated) {
      return;
    }
    // Aborted when the pull request or credential changes, so a load no
    // longer wanted doesn't hold up the write queue.
    const controller = new AbortController();
    void enqueue(async () => {
      // Unreachable, refused, or too large to read in full: keep working
      // from this browser's copy (submitting reads it again, and refuses
      // what it can't read in full).
      const remote = await fetchPendingReview(
        pullRequest,
        controller.signal
      ).catch((error: unknown) => {
        if (
          error instanceof APIRequestError &&
          error.code === 'incomplete-review'
        ) {
          toast.error(error.message, { id: 'pending-review-incomplete' });
        }
        return undefined;
      });
      if (controller.signal.aborted || remote === undefined) {
        return;
      }
      reconcile(remote);
      for (const entry of entriesRef.current.values()) {
        if (needsSave(entry)) {
          void saveDraft(entry.key);
        }
      }
    });
    return () => controller.abort();
    // Re-seeds per pull request and credential only; the rest is read
    // through refs or is stable.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, hasToken, hydrated, tokenVersion]);

  // Persist on every change to this pull request's batch. The seeded map
  // itself is skipped — writing it back would re-serialize what was read.
  useEffect(() => {
    if (
      storageKey == null ||
      ownerKeyRef.current !== storageKey ||
      pendingReviewComments === seededMapRef.current
    ) {
      return;
    }
    savePendingReviewComments(storageKey, [...pendingReviewComments.values()]);
  }, [pendingReviewComments, storageKey]);

  // Inject the pending cards whenever the batch or the viewer changes:
  // reloads rebuild the items without their annotations, and drafts arrive
  // from GitHub after the first render. Injection skips cards already
  // present, so this is idempotent, except that a card showing older text
  // than its entry (GitHub's text adopted on reconciling) is replaced.
  // Entries whose file vanished from the diff (e.g. a new push) keep their
  // text in the batch with no card.
  useEffect(() => {
    const viewerHandle = viewerRef.current;
    if (
      pendingReviewComments.size === 0 ||
      pathToItemId == null ||
      viewerHandle == null ||
      loadState !== 'ready'
    ) {
      return;
    }
    applyViewerAnnotations(
      viewerHandle,
      pathToItemId,
      pendingReviewComments.values(),
      {
        createAnnotation: createPendingReviewAnnotation,
        getKey: (entry) => entry.key,
        getPath: (entry) => entry.path,
        isStale: (entry, annotation) =>
          annotation.metadata.kind === 'saved' &&
          annotation.metadata.message !== entry.message,
        onApplied: (fileDiff, itemId, _entry, annotation) =>
          callbacksRef.current.onRestored(
            createLocalSavedCommentEvent(fileDiff, itemId, annotation)
          ),
      }
    );
  }, [
    callbacksRef,
    loadState,
    pathToItemId,
    pendingReviewComments,
    viewerKey,
    viewerReadyTick,
    viewerRef,
  ]);

  // An edit keeps the commit the entry was first written against: its anchor
  // still describes that revision even if the diff has since reloaded.
  const handlePendingReviewCommentUpserted = useCallback(
    (entry: PendingReviewComment) => {
      const previous = entriesRef.current.get(entry.key);
      setEntries(
        new Map(entriesRef.current).set(entry.key, {
          ...previous,
          ...entry,
          commitId: previous?.commitId ?? pullHeadSha,
        })
      );
      void saveDraft(entry.key);
    },
    [pullHeadSha, saveDraft, setEntries]
  );

  // A draft still being added is deleted on GitHub by its save, which sees
  // it gone from the batch.
  const handlePendingReviewCommentRemoved = useCallback(
    (key: string) => {
      const remoteId = entriesRef.current.get(key)?.remoteId;
      if (entriesRef.current.has(key)) {
        const next = new Map(entriesRef.current);
        next.delete(key);
        setEntries(next);
      }
      if (remoteId != null && pullRequest != null) {
        void enqueue(() =>
          deletePendingComment(pullRequest, remoteId).catch(handleDeleteFailed)
        );
      }
    },
    [enqueue, handleDeleteFailed, pullRequest, setEntries]
  );

  const submitPendingReview = useCallback(
    async (event: PullReviewEvent, body: string) => {
      if (pullRequest == null || !hasToken) {
        throw new Error(
          'Submitting a review requires signing in or saving a token.'
        );
      }
      // Let every save in flight finish first.
      await drainQueue();
      // Submitting publishes the whole pending review on GitHub, so read it
      // again first: another tab or GitHub's UI may have added, edited, or
      // submitted drafts since it loaded, and the reviewer has to see those
      // before they publish. It also finds a review this page lost track of
      // (a failed load or write), which submitting as a fresh review would
      // otherwise duplicate.
      if (reconcile(await fetchPendingReview(pullRequest))) {
        throw new Error(
          'Your pending review changed on GitHub, so the drafts here were updated from it. Check them and submit again.'
        );
      }
      const review = reviewRef.current;
      let entries = [...entriesRef.current.values()];
      if (review == null) {
        // Nothing saved to GitHub (no drafts, or none could be saved): submit
        // the verdict and any drafts in one call, as a fresh review.
        const commitChoice = chooseReviewCommit(entries, pullHeadSha);
        if (commitChoice.staleEntries.length > 0) {
          throw new Error(
            describeStaleReviewEntries(commitChoice.staleEntries)
          );
        }
        const comments: PullReviewDraftComment[] = [];
        for (const entry of entries) {
          const anchor = createCommentAnchor(entry.path, entry.range);
          if (anchor != null) {
            comments.push({ ...anchor, body: entry.message });
          }
        }
        await submitPullReview(
          pullRequest,
          readStoredGitHubToken(),
          event,
          body,
          comments,
          commitChoice.commitId
        );
      } else {
        const blocked = entries.flatMap((entry) => {
          const target =
            entry.remoteId == null ? getDraftTarget(entry, review) : null;
          return typeof target === 'string' ? [{ entry, target }] : [];
        });
        const stale = blocked.flatMap(({ entry, target }) =>
          target === 'stale' ? [entry] : []
        );
        // Drafts on the current push mean the review on GitHub is the older
        // one; it has to be submitted or discarded there first.
        const onHead = stale.filter((entry) => entry.commitId === pullHeadSha);
        if (onHead.length > 0) {
          throw new Error(describeOutdatedPendingReview(onHead));
        }
        if (stale.length > 0) {
          throw new Error(describeStaleReviewEntries(stale));
        }
        const unsaveable = blocked.flatMap(({ entry, target }) =>
          target === 'unsaveable' ? [entry] : []
        );
        if (unsaveable.length > 0) {
          throw new Error(describeUnsaveableReviewEntries(unsaveable));
        }
        // Retry saves that failed earlier, then check they all landed.
        for (const entry of entries) {
          if (needsSave(entry)) {
            void saveDraft(entry.key);
          }
        }
        await drainQueue();
        entries = [...entriesRef.current.values()];
        if (entries.some(needsSave)) {
          throw new Error(
            "Some draft comments couldn't be saved to GitHub, so the review wasn't submitted."
          );
        }
        try {
          await submitRemotePendingReview(pullRequest, review.id, event, body);
        } catch (error) {
          // Possibly submitted or deleted elsewhere: re-read it next time.
          reviewRef.current = undefined;
          throw error;
        }
        reviewRef.current = null;
      }
      removeCards(entries);
      setEntries(new Map());
    },
    [
      drainQueue,
      hasToken,
      pullHeadSha,
      pullRequest,
      reconcile,
      removeCards,
      saveDraft,
      setEntries,
    ]
  );

  return {
    handlePendingReviewCommentRemoved,
    handlePendingReviewCommentUpserted,
    pendingReviewComments,
    submitPendingReview,
  };
}

// A failed GitHub sync, with what happens to the draft next.
function toastSyncError(
  title: string,
  consequence: string,
  error: unknown,
  id?: string
): void {
  toast.error(title, {
    description:
      error instanceof Error ? `${error.message} ${consequence}` : undefined,
    id,
  });
}

// Whether GitHub lacks the draft or its latest text.
function needsSave(entry: PendingReviewComment): boolean {
  return entry.remoteId == null || entry.message !== entry.syncedMessage;
}

// Where a draft GitHub doesn't have yet would be added to the pending review
// `review` (undefined when unknown, in which case the server checks the
// commit), or why it can't be: 'stale' when written on another commit than
// the review's, 'unsaveable' without a recorded commit (saved by an earlier
// version), without a diff anchor, or as a reply (only GitHub's UI starts
// pending replies).
function getDraftTarget(
  entry: PendingReviewComment,
  review: { commitId: string } | null | undefined
): { anchor: GitHubCommentAnchor; commitId: string } | 'stale' | 'unsaveable' {
  if (
    entry.commitId != null &&
    review != null &&
    entry.commitId !== review.commitId
  ) {
    return 'stale';
  }
  const anchor = createCommentAnchor(entry.path, entry.range);
  if (entry.commitId == null || entry.inReplyTo != null || anchor == null) {
    return 'unsaveable';
  }
  return { anchor, commitId: entry.commitId };
}

function createPendingReviewAnnotation(
  entry: PendingReviewComment,
  fileDiff: FileDiffMetadata
): DiffLineAnnotation<SavedCommentMetadata> {
  return {
    side: getCommentAnnotationSide(entry.range, fileDiff),
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
