import type { FileDiffMetadata } from '../types';

// Whether `loadDiffFiles` can upgrade this diff to full file contents: only
// patch-parsed (partial) diffs that have both versions to load qualify.
// Added and deleted files already carry their whole contents in the patch.
export function canHydrateDiff(fileDiff: FileDiffMetadata): boolean {
  return (
    fileDiff.isPartial &&
    (fileDiff.type === 'change' ||
      fileDiff.type === 'rename-changed' ||
      fileDiff.type === 'rename-pure')
  );
}
