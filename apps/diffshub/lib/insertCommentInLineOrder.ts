import type { DiffsHubSavedCommentEntry } from './types';

// Places a comment thread in its file's list, which runs in line order.
// Updating a thread (a reply, resolving it) keeps its place when its line is
// unchanged, so it doesn't jump past other threads on the same line in the
// sidebar or in previous/next comment stepping.
export function insertCommentInLineOrder(
  comments: readonly DiffsHubSavedCommentEntry[],
  entry: DiffsHubSavedCommentEntry
): DiffsHubSavedCommentEntry[] {
  let existingIndex = -1;
  for (let index = 0; index < comments.length; index++) {
    if (comments[index]?.key === entry.key) {
      existingIndex = index;
      break;
    }
  }

  if (comments[existingIndex]?.lineNumber === entry.lineNumber) {
    return comments.with(existingIndex, entry);
  }

  const nextComments =
    existingIndex === -1
      ? [...comments]
      : comments.filter((_, index) => index !== existingIndex);

  let insertIndex = nextComments.length;
  for (let index = 0; index < nextComments.length; index++) {
    const comment = nextComments[index];
    if (comment != null && entry.lineNumber < comment.lineNumber) {
      insertIndex = index;
      break;
    }
  }

  nextComments.splice(insertIndex, 0, entry);
  return nextComments;
}
