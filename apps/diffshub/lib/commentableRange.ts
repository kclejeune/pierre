import type {
  FileDiffMetadata,
  SelectedLineRange,
  SelectionSide,
} from '@pierre/diffs';

// Whether GitHub will accept a pull-request review comment anchored to
// `range`. GitHub only resolves lines inside the diff's hunks: unchanged
// lines revealed by expanding a collapsed region are outside every hunk, and
// a comment there fails with 422 ("line must be part of the diff"). A
// multi-line comment must also start and end in the same hunk.
export function isRangeInsideSingleHunk(
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange
): boolean {
  const endSide = range.endSide ?? range.side;
  const startSide = range.side ?? endSide;
  if (endSide == null || startSide == null) {
    return false;
  }
  const endHunkIndex = findHunkIndex(fileDiff, endSide, range.end);
  return (
    endHunkIndex !== -1 &&
    findHunkIndex(fileDiff, startSide, range.start) === endHunkIndex
  );
}

// Index of the hunk whose header range on `side` covers `lineNumber`
// (1-based), or -1 when the line is outside every hunk.
function findHunkIndex(
  fileDiff: FileDiffMetadata,
  side: SelectionSide,
  lineNumber: number
): number {
  return fileDiff.hunks.findIndex((hunk) => {
    const start =
      side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    const count =
      side === 'additions' ? hunk.additionCount : hunk.deletionCount;
    return lineNumber >= start && lineNumber < start + count;
  });
}
