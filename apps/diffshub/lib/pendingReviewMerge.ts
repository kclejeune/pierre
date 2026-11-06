import type {
  RemotePendingComment,
  RemotePendingReview,
} from './pendingReview';
import { getAnchorRange } from './pullReviewThreads';
import type { CommentAuthor, PendingReviewComment } from './types';

// Reconciles this browser's copy of a pending review batch with the viewer's
// pending review on GitHub, which wins wherever both know a draft:
//
// - A local draft GitHub has (matched by remoteId) takes GitHub's text,
//   unless it carries an edit GitHub hasn't saved yet (message differs from
//   syncedMessage), which is kept so it can be saved.
// - A local draft that was saved to GitHub but is gone there was deleted or
//   submitted elsewhere, and is dropped.
// - A local draft never saved to GitHub is kept, to be saved.
// - A GitHub draft this browser doesn't know (written in GitHub's UI or
//   another browser) is added.
//
// Local drafts keep their keys, so reconciling never duplicates a card.
export function mergePendingReview(
  local: readonly PendingReviewComment[],
  remote: RemotePendingReview | null,
  author: CommentAuthor
): PendingReviewComment[] {
  const remoteById = new Map(
    (remote?.comments ?? []).map((comment) => [comment.id, comment])
  );
  const merged: PendingReviewComment[] = [];
  for (const entry of local) {
    if (entry.remoteId == null) {
      merged.push(entry);
      continue;
    }
    const comment = remoteById.get(entry.remoteId);
    if (comment == null) {
      continue;
    }
    remoteById.delete(entry.remoteId);
    const dirty =
      entry.syncedMessage != null && entry.message !== entry.syncedMessage;
    merged.push({
      ...entry,
      message: dirty ? entry.message : comment.body,
      syncedMessage: comment.body,
    });
  }
  if (remote != null) {
    for (const comment of remoteById.values()) {
      merged.push(remoteDraftEntry(comment, remote.commitId, author));
    }
  }
  return merged;
}

export function remoteDraftKey(remoteId: string): string {
  return `remote-${remoteId}`;
}

function remoteDraftEntry(
  comment: RemotePendingComment,
  commitId: string,
  author: CommentAuthor
): PendingReviewComment {
  return {
    author,
    commitId,
    inReplyTo: comment.inReplyTo,
    key: remoteDraftKey(comment.id),
    message: comment.body,
    path: comment.path,
    range: getAnchorRange(comment),
    remoteId: comment.id,
    syncedMessage: comment.body,
  };
}
