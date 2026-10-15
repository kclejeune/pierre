import type { PendingReviewComment } from './types';

// Which commit a batched review anchors to. GitHub resolves each comment's
// line/side against the diff at the review's `commit_id`; anchoring to
// whatever the head is at submit time instead fails with 422 ("line must be
// part of the diff") whenever the author pushed after the reviewer's diff
// loaded. Pending entries therefore record the head they were written on.

export interface ReviewCommitChoice {
  // Undefined lets the route resolve the pull's current head.
  commitId: string | undefined;
  // Entries written on a different commit than `commitId`. A review has one
  // `commit_id`, so a non-empty list means the batch cannot be submitted.
  staleEntries: PendingReviewComment[];
}

// Picks the single commit a batched review submits against: the rendered
// head when some entry was written on it (or no entry records a commit), else
// the most recently added entry's commit. That keeps a batch written before a
// push anchored to the revision its comments describe.
export function chooseReviewCommit(
  entries: readonly PendingReviewComment[],
  renderedHeadSha: string | undefined
): ReviewCommitChoice {
  const commitIds = new Set(
    entries.flatMap((entry) => (entry.commitId == null ? [] : [entry.commitId]))
  );
  const commitId =
    commitIds.size === 0 ||
    (renderedHeadSha != null && commitIds.has(renderedHeadSha))
      ? renderedHeadSha
      : entries.findLast((entry) => entry.commitId != null)?.commitId;
  return {
    commitId,
    staleEntries: entries.filter(
      (entry) => entry.commitId != null && entry.commitId !== commitId
    ),
  };
}

const STALE_ENTRY_PREVIEW_COUNT = 3;

// The user-facing refusal for a batch that spans revisions: which pending
// comments are on an older push, and what to do about them.
export function describeStaleReviewEntries(
  staleEntries: readonly PendingReviewComment[]
): string {
  const locations = staleEntries
    .slice(0, STALE_ENTRY_PREVIEW_COUNT)
    .map((entry) => `${entry.path}:${entry.range.end}`);
  const remaining = staleEntries.length - locations.length;
  if (remaining > 0) {
    locations.push(`${remaining} more`);
  }
  const count =
    staleEntries.length === 1
      ? '1 pending comment was'
      : `${staleEntries.length} pending comments were`;
  return `${count} written on an earlier push of this pull request and can't be submitted with the rest (${locations.join(', ')}). Copy their text, delete them, and add them again on the current diff.`;
}
