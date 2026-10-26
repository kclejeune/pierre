import type { FileDiffMetadata } from '@pierre/diffs';

import { iterateHunkLineBlocks } from './hunkLineBlocks';

// Change information for a diff expressed in new-file line numbers, used by
// the rendered-markdown view to mark which document blocks a diff touches.
export interface NewFileChangeMap {
  // New-file lines that are additions.
  addedLines: ReadonlySet<number>;
  // New-file lines at which one or more old-file lines were deleted (the
  // position where the removed content used to sit).
  deletionAnchors: ReadonlySet<number>;
}

export function buildNewFileChangeMap(
  fileDiff: FileDiffMetadata
): NewFileChangeMap {
  const addedLines = new Set<number>();
  const deletionAnchors = new Set<number>();
  for (const block of iterateHunkLineBlocks(fileDiff, 'additions')) {
    if (block.type === 'context') {
      continue;
    }
    if (block.deletions > 0) {
      deletionAnchors.add(block.startLine);
    }
    for (let index = 0; index < block.lineCount; index++) {
      addedLines.add(block.startLine + index);
    }
  }
  return { addedLines, deletionAnchors };
}

// Whether the inclusive new-file line range [startLine, endLine] contains any
// change — an added line, or the anchor of a deletion.
export function rangeHasChanges(
  changeMap: NewFileChangeMap,
  startLine: number,
  endLine: number
): boolean {
  for (let line = startLine; line <= endLine; line++) {
    if (changeMap.addedLines.has(line) || changeMap.deletionAnchors.has(line)) {
      return true;
    }
  }
  return false;
}

// Picks a new-file line inside [startLine, endLine] that is part of the
// rendered diff, so a comment created from the rendered document lands on a
// visible (and GitHub-commentable) row. Prefers added lines, falls back to
// context lines inside hunks, and returns null when the range is entirely
// outside the diff.
export function findCommentableNewLine(
  fileDiff: FileDiffMetadata,
  startLine: number,
  endLine: number
): number | null {
  for (const block of iterateHunkLineBlocks(fileDiff, 'additions')) {
    if (block.type === 'context' || block.lineCount === 0) {
      continue;
    }
    const overlapStart = Math.max(block.startLine, startLine);
    const overlapEnd = Math.min(block.startLine + block.lineCount - 1, endLine);
    if (overlapStart <= overlapEnd) {
      return overlapStart;
    }
  }

  for (const hunk of fileDiff.hunks) {
    const overlapStart = Math.max(hunk.additionStart, startLine);
    const overlapEnd = Math.min(
      hunk.additionStart + hunk.additionCount - 1,
      endLine
    );
    if (overlapStart <= overlapEnd) {
      return overlapStart;
    }
  }
  return null;
}

// Maps an old-file line to the new-file line where its content sits, so a
// search match on a removed line can be shown in the rendered (post-change)
// document. Lines inside a removed block map to the new-file position the
// block used to occupy, the same anchor buildNewFileChangeMap marks; lines
// outside every hunk shift by the line-count difference accumulated before
// them. Unchanged gaps between hunks have the same length on both sides, so
// the old-file position of each additions-side block is its start minus that
// running difference.
export function toNewFileLine(
  fileDiff: FileDiffMetadata,
  oldLine: number
): number {
  let offset = 0;
  for (const block of iterateHunkLineBlocks(fileDiff, 'additions')) {
    const oldStart = block.startLine - offset;
    if (oldLine < oldStart) {
      break;
    }
    if (block.type === 'context') {
      if (oldLine < oldStart + block.lineCount) {
        return block.startLine + (oldLine - oldStart);
      }
      continue;
    }
    if (oldLine < oldStart + block.deletions) {
      return block.startLine;
    }
    offset += block.lineCount - block.deletions;
  }
  return oldLine + offset;
}
