import type { SelectedLineRange, SelectionSide } from '@pierre/diffs';

import { isFullCommitSha } from './githubDiffSource';
import { readStoredJSON, writeStoredJSON } from './storedJSON';
import type { CommentAuthor, PendingReviewComment } from './types';

// Local copy of the in-progress batched review, per pull request. GitHub's
// pending review is the source of truth once a draft is saved there
// (lib/pendingReview); this copy keeps drafts GitHub hasn't confirmed yet
// (offline, a failed save, signed out) so they survive a reload and are
// saved on the next visit.

const STORAGE_PREFIX = 'diffshub.pending-review.';

export function getPendingReviewStorageKey(pullRequest: {
  number: string;
  owner: string;
  repo: string;
}): string {
  return `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
}

export function loadPendingReviewComments(
  storageKey: string
): PendingReviewComment[] {
  const parsed = readStoredJSON(STORAGE_PREFIX + storageKey);
  if (!Array.isArray(parsed)) {
    return [];
  }
  // A corrupt commit id degrades to "unknown revision" rather than discarding
  // the comment text along with it.
  return parsed.filter(isPendingReviewComment).map((entry) => ({
    ...entry,
    commitId:
      entry.commitId !== undefined && isFullCommitSha(entry.commitId)
        ? entry.commitId
        : undefined,
    inReplyTo:
      typeof entry.inReplyTo === 'number' ? entry.inReplyTo : undefined,
    remoteId: typeof entry.remoteId === 'string' ? entry.remoteId : undefined,
    syncedMessage:
      typeof entry.syncedMessage === 'string' ? entry.syncedMessage : undefined,
  }));
}

export function savePendingReviewComments(
  storageKey: string,
  entries: readonly PendingReviewComment[]
): void {
  writeStoredJSON(
    STORAGE_PREFIX + storageKey,
    entries.length === 0 ? null : entries
  );
}

function isPendingReviewComment(value: unknown): value is PendingReviewComment {
  if (typeof value !== 'object' || value == null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key === 'string' &&
    entry.key !== '' &&
    typeof entry.message === 'string' &&
    typeof entry.path === 'string' &&
    entry.path !== '' &&
    isCommentAuthor(entry.author) &&
    isSelectedLineRange(entry.range)
  );
}

function isCommentAuthor(value: unknown): value is CommentAuthor {
  if (typeof value !== 'object' || value == null) {
    return false;
  }
  const author = value as Record<string, unknown>;
  return (
    typeof author.avatarUrl === 'string' && typeof author.login === 'string'
  );
}

function isSelectedLineRange(value: unknown): value is SelectedLineRange {
  if (typeof value !== 'object' || value == null) {
    return false;
  }
  const range = value as Record<string, unknown>;
  return (
    typeof range.start === 'number' &&
    typeof range.end === 'number' &&
    isOptionalSelectionSide(range.side) &&
    isOptionalSelectionSide(range.endSide)
  );
}

function isOptionalSelectionSide(
  value: unknown
): value is SelectionSide | undefined {
  return value === undefined || value === 'deletions' || value === 'additions';
}
