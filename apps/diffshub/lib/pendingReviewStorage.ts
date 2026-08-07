import type { SelectedLineRange, SelectionSide } from '@pierre/diffs';

import { readStoredJSON, writeStoredJSON } from './storedJSON';
import type { CommentAuthor, PendingReviewComment } from './types';

// Persistence for the in-progress batched review. GitHub keeps pending
// reviews server-side, so reviewers trust that a half-written batch survives
// a reload — mirroring that, the batch is stored per pull request in
// localStorage and restored into the viewer on the next visit.

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
  return parsed.filter(isPendingReviewComment);
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
