import type { FileDiffMetadata } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import {
  applySuggestion,
  buildSuggestionBlock,
  getNewFileLines,
  hasSuggestion,
} from '@/lib/suggestedChange';

const fullDiff = {
  additionLines: ['a\n', 'b\n', 'c\n'],
  hunks: [],
  isPartial: false,
} as unknown as FileDiffMetadata;

const partialDiff = {
  additionLines: ['x\n', 'y\n', 'z\n'],
  hunks: [{ additionCount: 3, additionLineIndex: 0, additionStart: 10 }],
  isPartial: true,
} as unknown as FileDiffMetadata;

describe('getNewFileLines', () => {
  test('reads full files by line number and partial ones through hunks', () => {
    expect(getNewFileLines(fullDiff, 2, 3)).toEqual(['b', 'c']);
    expect(getNewFileLines(partialDiff, 11, 12)).toEqual(['y', 'z']);
    expect(getNewFileLines(partialDiff, 12, 13)).toBeNull();
  });
});

describe('buildSuggestionBlock', () => {
  test('fences the lines, outlasting backtick runs inside', () => {
    expect(buildSuggestionBlock(['const a = 1;'])).toBe(
      '```suggestion\nconst a = 1;\n```'
    );
    expect(buildSuggestionBlock(['```js'])).toBe('````suggestion\n```js\n````');
  });
});

describe('applySuggestion', () => {
  test('replaces the anchored lines and keeps the final newline', () => {
    expect(applySuggestion('a\nb\nc\n', 2, 2, 'B1\nB2')).toBe('a\nB1\nB2\nc\n');
    expect(applySuggestion('a\nb\nc', 1, 2, '')).toBe('c');
    expect(applySuggestion('a\r\nb\r\n', 2, 2, 'B')).toBe('a\r\nB\r\n');
    expect(applySuggestion('a\n', 2, 2, 'x')).toBeNull();
  });
});

describe('hasSuggestion', () => {
  test('finds suggestion fences of any length, not other fences', () => {
    expect(hasSuggestion('Try:\n```suggestion\nx\n```')).toBe(true);
    expect(hasSuggestion('````suggestion\n```js\n````')).toBe(true);
    expect(hasSuggestion('```ts\nsuggestion\n```')).toBe(false);
    expect(hasSuggestion('a suggestion in prose')).toBe(false);
  });
});
