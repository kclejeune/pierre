import { parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import { buildNewFileChangeMap, toNewFileLine } from '../markdownChangeMap';

// 30 lines; line 5 is replaced by two lines and line 20 is deleted, so the
// diff has two hunks with unchanged lines before, between, and after them.
const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`);
const newLines = [
  ...oldLines.slice(0, 4),
  'five a\n',
  'five b\n',
  ...oldLines.slice(5, 19),
  ...oldLines.slice(20),
];
const fileDiff = parseDiffFromFile(
  { name: 'README.md', contents: oldLines.join('') },
  { name: 'README.md', contents: newLines.join('') }
);

describe('toNewFileLine', () => {
  test('keeps lines before the first hunk in place', () => {
    expect(toNewFileLine(fileDiff, 1)).toBe(1);
  });

  test('maps context lines inside a hunk', () => {
    expect(toNewFileLine(fileDiff, 4)).toBe(4);
    expect(toNewFileLine(fileDiff, 6)).toBe(7);
  });

  test('anchors removed lines where their content used to sit', () => {
    expect(toNewFileLine(fileDiff, 5)).toBe(5);
    expect(toNewFileLine(fileDiff, 20)).toBe(21);
  });

  test('shifts lines between and after hunks by the accumulated offset', () => {
    expect(toNewFileLine(fileDiff, 12)).toBe(13);
    expect(toNewFileLine(fileDiff, 21)).toBe(21);
    expect(toNewFileLine(fileDiff, 30)).toBe(30);
  });
});

// Zero-context hunks: one removes old lines 3-4, the other adds new lines 7-8
// after old line 8. A side with no lines names the line before the hunk.
const [zeroContextDiff] = parsePatchFiles(`diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -3,2 +2,0 @@
-three
-four
@@ -8,0 +7,2 @@
+new a
+new b
`)[0].files;

describe('zero-context hunks', () => {
  test('anchor removed lines after the preceding new-file line', () => {
    expect(toNewFileLine(zeroContextDiff, 3)).toBe(3);
    expect(toNewFileLine(zeroContextDiff, 4)).toBe(3);
    expect(buildNewFileChangeMap(zeroContextDiff).deletionAnchors).toEqual(
      new Set([3])
    );
  });

  test('shift unchanged lines around them', () => {
    expect(toNewFileLine(zeroContextDiff, 2)).toBe(2);
    expect(toNewFileLine(zeroContextDiff, 5)).toBe(3);
    expect(toNewFileLine(zeroContextDiff, 8)).toBe(6);
    expect(toNewFileLine(zeroContextDiff, 9)).toBe(9);
  });

  test('place pure additions on their own lines', () => {
    expect(buildNewFileChangeMap(zeroContextDiff).addedLines).toEqual(
      new Set([7, 8])
    );
  });
});
