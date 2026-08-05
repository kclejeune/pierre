import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';

import { classifyCommentLineType } from './classifyCommentLineType';
import type {
  DiffsHubSavedCommentEvent,
  PullReviewThread,
  SavedCommentMetadata,
} from './types';

// Builders for the sidebar-sync event emitted whenever a comment is created
// or its root content changes, so every emit site derives the same shape (and
// the same line classification) instead of assembling the event by hand.

// The sidebar row for a GitHub-backed thread mirrors the thread's first
// comment, plus the participant set and reply count so the row can convey
// the conversation behind it.
export function createThreadSavedCommentEvent(
  fileDiff: FileDiffMetadata,
  itemId: string,
  thread: PullReviewThread
): DiffsHubSavedCommentEvent {
  const root = thread.comments[0];
  const participants: DiffsHubSavedCommentEvent['participants'] = [];
  const seenLogins = new Set<string>();
  for (const comment of thread.comments) {
    if (!seenLogins.has(comment.author.login)) {
      seenLogins.add(comment.author.login);
      participants.push(comment.author);
    }
  }
  return {
    author: root.author,
    itemId,
    key: thread.key,
    lineNumber: thread.lineNumber,
    lineType: classifyCommentLineType(fileDiff, thread.side, thread.lineNumber),
    message: root.body,
    participants,
    range: thread.range,
    replyCount: thread.comments.length - 1,
    side: thread.side,
  };
}

export function createLocalSavedCommentEvent(
  fileDiff: FileDiffMetadata,
  itemId: string,
  annotation: DiffLineAnnotation<SavedCommentMetadata>
): DiffsHubSavedCommentEvent {
  const { author, key, message, range } = annotation.metadata;
  return {
    author,
    itemId,
    key,
    lineNumber: annotation.lineNumber,
    lineType: classifyCommentLineType(
      fileDiff,
      annotation.side,
      annotation.lineNumber
    ),
    message,
    participants: [author],
    range,
    replyCount: 0,
    side: annotation.side,
  };
}
