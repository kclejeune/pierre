import { isFileCommentRange } from './pullReviewThreads';
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

const ENTRY_PREVIEW_COUNT = 3;

// The user-facing refusal for a batch that spans revisions: which pending
// comments are on an older push, and what to do about them.
export function describeStaleReviewEntries(
  staleEntries: readonly PendingReviewComment[]
): string {
  return describeEntries(
    staleEntries,
    ['1 pending comment was', 'pending comments were'],
    "written on an earlier push of this pull request and can't be submitted with the rest",
    'Copy their text, delete them, and add them again on the current diff.'
  );
}

// What to do while the viewer's pending review on GitHub is pinned to an
// earlier push than the drafts being added to it: GitHub reads a review's
// lines against its commit, so they can't join it.
export const OUTDATED_PENDING_REVIEW_HINT =
  'That review was started on an earlier push of this pull request. Submit or discard it on GitHub to add drafts written on this push; until then they stay in this browser.';

// Why submitting refuses drafts written on the current push while the
// viewer's pending review on GitHub is pinned to an earlier one.
export function describeOutdatedPendingReview(
  entries: readonly PendingReviewComment[]
): string {
  return describeEntries(
    entries,
    ["1 draft comment on this push can't", "draft comments on this push can't"],
    'be added to your pending review on GitHub, which was started on an earlier push of this pull request',
    'Submit or discard that review on GitHub, then submit again.'
  );
}

// Why submitting refuses drafts that can't be added to the pending review on
// GitHub: no recorded commit (saved by an earlier version of DiffsHub), no
// diff anchor, or a reply GitHub doesn't have.
export function describeUnsaveableReviewEntries(
  entries: readonly PendingReviewComment[]
): string {
  return describeEntries(
    entries,
    ["1 pending comment can't", "pending comments can't"],
    'be added to your pending review on GitHub',
    'Copy their text, delete them, and add them again on the current diff.'
  );
}

// "<count> <what> (<locations>). <remedy>": `one` is the phrase for a single
// entry, `many` the plural one that follows the count.
function describeEntries(
  entries: readonly PendingReviewComment[],
  [one, many]: readonly [string, string],
  what: string,
  remedy: string
): string {
  const count = entries.length === 1 ? one : `${entries.length} ${many}`;
  return `${count} ${what} (${describeEntryLocations(entries)}). ${remedy}`;
}

// "path:line" (or "path" for a file-level comment) for the first few
// entries, then a count of the rest.
function describeEntryLocations(
  entries: readonly PendingReviewComment[]
): string {
  const locations = entries
    .slice(0, ENTRY_PREVIEW_COUNT)
    .map((entry) =>
      isFileCommentRange(entry.range)
        ? entry.path
        : `${entry.path}:${entry.range.end}`
    );
  const remaining = entries.length - locations.length;
  if (remaining > 0) {
    locations.push(`${remaining} more`);
  }
  return locations.join(', ');
}
