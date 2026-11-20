import { describe, expect, test } from 'bun:test';

import { insertCommentInLineOrder } from '../lib/insertCommentInLineOrder';
import type { DiffsHubSavedCommentEntry } from '../lib/types';

function comment(key: string, lineNumber: number): DiffsHubSavedCommentEntry {
  return {
    author: { avatarUrl: '', login: 'octo' },
    itemId: 'a',
    key,
    lineNumber,
    lineType: 'change',
    message: key,
    participants: [],
    range: { end: lineNumber, side: 'additions', start: lineNumber },
    replyCount: 0,
    side: 'additions',
  };
}

const keys = (comments: readonly DiffsHubSavedCommentEntry[]) =>
  comments.map((entry) => entry.key);

describe('insertCommentInLineOrder', () => {
  const list = [comment('x', 3), comment('y', 3), comment('z', 9)];

  test('a new thread goes after existing threads on its line', () => {
    expect(keys(insertCommentInLineOrder(list, comment('w', 3)))).toEqual([
      'x',
      'y',
      'w',
      'z',
    ]);
  });

  test('an updated thread on the same line keeps its place', () => {
    const updated = { ...comment('x', 3), replyCount: 1 };
    const result = insertCommentInLineOrder(list, updated);
    expect(keys(result)).toEqual(['x', 'y', 'z']);
    expect(result[0]).toBe(updated);
  });

  test('a thread whose line moved is re-placed', () => {
    expect(keys(insertCommentInLineOrder(list, comment('x', 5)))).toEqual([
      'y',
      'x',
      'z',
    ]);
  });
});
