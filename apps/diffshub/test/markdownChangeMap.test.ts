import { parseDiffFromFile } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import {
  buildNewFileChangeMap,
  findCommentableNewLine,
  rangeHasChanges,
} from '../lib/markdownChangeMap';

const OLD_DOC = [
  '# Title',
  '',
  'Intro paragraph.',
  '',
  'Removed section.',
  '',
  'Stable tail.',
].join('\n');

const NEW_DOC = [
  '# Title',
  '',
  'Intro paragraph, edited.',
  '',
  'Stable tail.',
  '',
  'Appended section.',
].join('\n');

// parseDiffFromFile diffs full contents, so the metadata mirrors what a
// hydrated markdown diff looks like in the viewer.
const fileDiff = parseDiffFromFile(
  { name: 'README.md', contents: OLD_DOC },
  { name: 'README.md', contents: NEW_DOC }
);

describe('buildNewFileChangeMap', () => {
  const changeMap = buildNewFileChangeMap(fileDiff);

  test('marks added new-file lines', () => {
    // "Intro paragraph, edited." replaced line 3; "Appended section." is new.
    expect(changeMap.addedLines.has(3)).toBe(true);
    expect(changeMap.addedLines.has(7)).toBe(true);
    expect(changeMap.addedLines.has(1)).toBe(false);
  });

  test('anchors deletions to the new-file position they were removed from', () => {
    expect(changeMap.deletionAnchors.size).toBeGreaterThan(0);
  });

  test('rangeHasChanges sees changed and unchanged block ranges', () => {
    expect(rangeHasChanges(changeMap, 3, 3)).toBe(true);
    expect(rangeHasChanges(changeMap, 1, 1)).toBe(false);
  });
});

describe('findCommentableNewLine', () => {
  test('prefers an added line inside the range', () => {
    expect(findCommentableNewLine(fileDiff, 3, 3)).toBe(3);
    expect(findCommentableNewLine(fileDiff, 6, 7)).toBe(7);
  });

  test('falls back to a context line covered by a hunk', () => {
    const line = findCommentableNewLine(fileDiff, 1, 2);
    expect(line).not.toBeNull();
    expect(fileDiff.hunks[0].additionStart).toBeLessThanOrEqual(line ?? -1);
  });

  test('returns null outside every hunk', () => {
    expect(findCommentableNewLine(fileDiff, 1000, 1001)).toBeNull();
  });
});
