import { parsePatchFiles } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import { isRangeInsideSingleHunk } from '@/lib/commentableRange';

// Two hunks: new-file lines 2-5 and 20-23 (old-file 2-4 and 19-22). Lines
// between them (6-19 on the new side) are collapsed context that hunk
// expansion can reveal but GitHub cannot anchor comments to.
const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -2,3 +2,4 @@
 line 2
+added 3
 line 4
 line 5
@@ -19,4 +20,4 @@
 line 19
-old 20
+new 21
 line 22
 line 23
`;

const fileDiff = parsePatchFiles(PATCH)[0]?.files[0];
if (fileDiff == null) {
  throw new Error('fixture patch did not parse');
}

describe('isRangeInsideSingleHunk', () => {
  test('accepts single lines inside a hunk on either side', () => {
    expect(
      isRangeInsideSingleHunk(fileDiff, {
        start: 3,
        side: 'additions',
        end: 3,
        endSide: 'additions',
      })
    ).toBe(true);
    expect(
      isRangeInsideSingleHunk(fileDiff, {
        start: 20,
        side: 'deletions',
        end: 20,
        endSide: 'deletions',
      })
    ).toBe(true);
  });

  test('rejects expanded context between hunks', () => {
    expect(
      isRangeInsideSingleHunk(fileDiff, {
        start: 10,
        side: 'additions',
        end: 10,
        endSide: 'additions',
      })
    ).toBe(false);
  });

  test('rejects lines past the last hunk', () => {
    expect(
      isRangeInsideSingleHunk(fileDiff, {
        start: 24,
        side: 'additions',
        end: 24,
        endSide: 'additions',
      })
    ).toBe(false);
  });

  test('accepts a multi-line range crossing sides within one hunk', () => {
    expect(
      isRangeInsideSingleHunk(fileDiff, {
        start: 20,
        side: 'deletions',
        end: 22,
        endSide: 'additions',
      })
    ).toBe(true);
  });

  test('rejects a multi-line range spanning two hunks', () => {
    expect(
      isRangeInsideSingleHunk(fileDiff, {
        start: 4,
        side: 'additions',
        end: 21,
        endSide: 'additions',
      })
    ).toBe(false);
  });

  test('rejects a range without a side', () => {
    expect(isRangeInsideSingleHunk(fileDiff, { start: 3, end: 3 })).toBe(false);
  });
});
