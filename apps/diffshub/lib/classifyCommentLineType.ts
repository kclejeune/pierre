import type { AnnotationSide, FileDiffMetadata } from '@pierre/diffs';

import { iterateHunkLineBlocks } from './hunkLineBlocks';
import type { CommentLineType } from './types';

// Classifies a 1-based line number on a given diff side as either an actual
// addition/deletion or an unchanged context line. The sidebar uses this to
// avoid rendering "+13" / "-13" for comments anchored to lines that are
// rendered as context (and therefore weren't actually added or removed).
export function classifyCommentLineType(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number
): CommentLineType {
  for (const block of iterateHunkLineBlocks(fileDiff, side)) {
    if (block.lineCount === 0) {
      continue;
    }
    if (lineNumber < block.startLine) {
      // Blocks arrive in increasing line order, so the line isn't in the diff.
      break;
    }
    if (lineNumber < block.startLine + block.lineCount) {
      return block.type;
    }
  }
  return 'change';
}
