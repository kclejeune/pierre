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
