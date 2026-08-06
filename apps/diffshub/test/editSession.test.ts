import { describe, expect, test } from 'bun:test';

import {
  defaultCommitMessage,
  type DirtyFileEntry,
  removeDirtyFile,
  upsertDirtyFile,
} from '@/lib/editSession';

const A: DirtyFileEntry = { itemId: 'a', path: 'src/a.ts' };
const B: DirtyFileEntry = { itemId: 'b', path: 'src/b.ts' };

describe('upsertDirtyFile', () => {
  test('appends new entries in first-edited order', () => {
    const one = upsertDirtyFile([], A);
    const two = upsertDirtyFile(one, B);
    expect(two.map((entry) => entry.itemId)).toEqual(['a', 'b']);
  });

  test('returns the same reference when the item is already tracked', () => {
    const entries = [A, B];
    expect(upsertDirtyFile(entries, { ...A })).toBe(entries);
  });

  test('updates the path of an existing entry in place', () => {
    const updated = upsertDirtyFile([A, B], { itemId: 'a', path: 'moved.ts' });
    expect(updated.map((entry) => entry.path)).toEqual([
      'moved.ts',
      'src/b.ts',
    ]);
  });
});

describe('removeDirtyFile', () => {
  test('removes only the matching item', () => {
    expect(removeDirtyFile([A, B], 'a')).toEqual([B]);
    expect(removeDirtyFile([A], 'missing')).toEqual([A]);
  });
});

describe('defaultCommitMessage', () => {
  test('names a single file and counts several', () => {
    expect(defaultCommitMessage([A])).toBe('Update src/a.ts');
    expect(defaultCommitMessage([A, B])).toBe('Update 2 files');
  });
});
