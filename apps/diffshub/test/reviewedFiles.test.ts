import type { FileDiffMetadata } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import { getFileDiffFingerprint } from '@/lib/reviewedFiles';

function createFileDiff(
  overrides: Partial<FileDiffMetadata> = {}
): FileDiffMetadata {
  return {
    name: 'pkg/server.go',
    type: 'modified',
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    ...overrides,
  } as FileDiffMetadata;
}

describe('getFileDiffFingerprint', () => {
  test('uses the git object id when the patch provides one', () => {
    const fileDiff = createFileDiff({ newObjectId: 'abc123' });
    expect(getFileDiffFingerprint(fileDiff)).toBe('oid:abc123');
  });

  test('object id changes invalidate the fingerprint', () => {
    const before = createFileDiff({ newObjectId: 'abc123' });
    const after = createFileDiff({ newObjectId: 'def456' });
    expect(getFileDiffFingerprint(before)).not.toBe(
      getFileDiffFingerprint(after)
    );
  });

  test('falls back to a stable hunk-structure hash without object ids', () => {
    const hunk = {
      additionStart: 10,
      additionCount: 5,
      additionLines: 3,
      deletionStart: 10,
      deletionCount: 2,
      deletionLines: 1,
    } as FileDiffMetadata['hunks'][number];
    const first = createFileDiff({ hunks: [hunk] });
    const second = createFileDiff({ hunks: [hunk] });
    const changed = createFileDiff({
      hunks: [{ ...hunk, additionLines: 4 }],
    });
    expect(getFileDiffFingerprint(first)).toBe(getFileDiffFingerprint(second));
    expect(getFileDiffFingerprint(first)).not.toBe(
      getFileDiffFingerprint(changed)
    );
  });
});
