import { describe, expect, test } from 'bun:test';

import { readDiffHunkSnippet } from '../lib/diffHunkSnippet';

describe('readDiffHunkSnippet', () => {
  test('keeps the last lines, numbered on their own side', () => {
    const hunk = [
      '@@ -10,6 +10,7 @@ function main() {',
      ' const a = 1;',
      ' const b = 2;',
      '-const c = 3;',
      '+const c = 4;',
      '+const d = 5;',
      ' return a;',
    ].join('\n');
    expect(readDiffHunkSnippet(hunk)).toEqual([
      { kind: 'deletion', lineNumber: 12, text: 'const c = 3;' },
      { kind: 'addition', lineNumber: 12, text: 'const c = 4;' },
      { kind: 'addition', lineNumber: 13, text: 'const d = 5;' },
      { kind: 'context', lineNumber: 14, text: 'return a;' },
    ]);
  });

  test('numbers context lines on a base-side thread by the old file', () => {
    const hunk = '@@ -10,3 +20,3 @@\n kept\n-gone\n+added';
    expect(readDiffHunkSnippet(hunk, 'LEFT')[0]).toEqual({
      kind: 'context',
      lineNumber: 10,
      text: 'kept',
    });
  });

  test('skips no-newline markers and a trailing newline', () => {
    const hunk = '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n';
    expect(readDiffHunkSnippet(hunk)).toEqual([
      { kind: 'deletion', lineNumber: 1, text: 'old' },
      { kind: 'addition', lineNumber: 1, text: 'new' },
    ]);
  });

  test('leaves lines unnumbered without a readable header', () => {
    expect(readDiffHunkSnippet('+added', 'RIGHT', 2)).toEqual([
      { kind: 'addition', lineNumber: null, text: 'added' },
    ]);
  });
});
