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
// comment.
export function createThreadSavedCommentEvent(
  fileDiff: FileDiffMetadata,
  itemId: string,
  thread: PullReviewThread
): DiffsHubSavedCommentEvent {
  const root = thread.comments[0];
  return {
    author: root.author,
    itemId,
    key: thread.key,
    lineNumber: thread.lineNumber,
    lineType: classifyCommentLineType(fileDiff, thread.side, thread.lineNumber),
    message: root.body,
    range: thread.range,
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
    range,
    side: annotation.side,
  };
}
