import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';

import { classifyCommentLineType } from './classifyCommentLineType';
import { createCommentSidebarPreview } from './commentSidebarPreview';
import type {
  CommentAuthor,
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
  const participants = uniqueCommentAuthors(thread.comments);
  return {
    author: root.author,
    itemId,
    key: thread.key,
    lineNumber: thread.lineNumber,
    lineType: classifyCommentLineType(fileDiff, thread.side, thread.lineNumber),
    message: createCommentSidebarPreview(root.body),
    participants,
    range: thread.range,
    replyCount: thread.comments.length - 1,
    ...(thread.state?.isResolved === true ? { resolved: true as const } : {}),
    reviewThread: true,
    side: thread.side,
  };
}

// A thread's participants, each once, in the order they first commented;
// shared by the rows for threads in the diff and those listed without a card
// (lib/detachedCommentSections), so both show the same avatars.
export function uniqueCommentAuthors(
  comments: readonly { author: CommentAuthor }[]
): CommentAuthor[] {
  const seen = new Set<string>();
  const authors: CommentAuthor[] = [];
  for (const { author } of comments) {
    if (!seen.has(author.login)) {
      seen.add(author.login);
      authors.push(author);
    }
  }
  return authors;
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
    message: createCommentSidebarPreview(message),
    participants: [author],
    range,
    replyCount: 0,
    side: annotation.side,
  };
}
