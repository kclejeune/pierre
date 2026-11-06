import type { CommentAnchor } from './pullReviewThreads';

// The viewer's pending (unsubmitted) review on a pull request, as GitHub
// stores it. GitHub keeps a review's draft comments server-side from the
// moment it is started, in its own UI or here, and shows them only to the
// review's author; /api/pull-review reads and writes it.

// A draft as DiffsHub adds it to the pending review.
export type PendingDraftComment = CommentAnchor & { body: string };

export type RemotePendingComment = PendingDraftComment & {
  // GraphQL node id, the handle edits and deletes use.
  id: string;
  // Set on a pending reply to an existing thread (started in GitHub's UI);
  // DiffsHub's own drafts are always new threads.
  inReplyTo?: number;
};

export interface RemotePendingReview {
  // The commit the review is pinned to: every comment's line/side is read
  // against the diff at this commit.
  commitId: string;
  comments: RemotePendingComment[];
  // GraphQL node id.
  id: string;
}

export interface PendingReviewPayload {
  review: RemotePendingReview | null;
}
