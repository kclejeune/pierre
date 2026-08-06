import type { AnnotationSide, FileDiffMetadata } from '@pierre/diffs';

// One hunk-content block positioned on a single side of the diff.
export interface HunkLineBlock {
  type: 'context' | 'change';
  // 1-based first line of the block on the walked side.
  startLine: number;
  // Lines the block occupies on the walked side (0 for a change block with no
  // lines there, e.g. a pure deletion walked on the additions side).
  lineCount: number;
  // Old-file lines a change block removes (0 for context); lets
  // additions-side walkers anchor removed content at the block's position.
  deletions: number;
}

// Yields each hunk's ordered content blocks with the running 1-based line
// number on the requested side — a context block advances both sides, a
// change block advances by its additions/deletions on the matching side.
// This is the single copy of the line accounting that
// classifyCommentLineType, buildNewFileChangeMap, and findCommentableNewLine
// share (mirroring FileDiff.getLineIndex inside @pierre/diffs). Blocks arrive
// in increasing line order across hunks.
export function* iterateHunkLineBlocks(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide
): Generator<HunkLineBlock> {
  for (const hunk of fileDiff.hunks) {
    let startLine =
      side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    for (const content of hunk.hunkContent) {
      const lineCount =
        content.type === 'context'
          ? content.lines
          : side === 'additions'
            ? content.additions
            : content.deletions;
      yield {
        type: content.type === 'context' ? 'context' : 'change',
        startLine,
        lineCount,
        deletions: content.type === 'context' ? 0 : content.deletions,
      };
      startLine += lineCount;
    }
  }
}
