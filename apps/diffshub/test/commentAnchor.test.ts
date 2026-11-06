import { describe, expect, test } from 'bun:test';

import { createCommentAnchor } from '@/lib/pullCommentsClient';
import {
  createFileCommentRange,
  getAnchorRange,
  readCommentAnchor,
} from '@/lib/pullReviewThreads';

describe('createCommentAnchor', () => {
  test('anchors a file-level range to the file alone', () => {
    expect(createCommentAnchor('src/a.ts', createFileCommentRange())).toEqual({
      path: 'src/a.ts',
      subjectType: 'file',
    });
  });

  test('anchors single- and multi-line ranges', () => {
    expect(
      createCommentAnchor('src/a.ts', {
        start: 4,
        side: 'additions',
        end: 4,
        endSide: 'additions',
      })
    ).toEqual({ line: 4, path: 'src/a.ts', side: 'RIGHT' });
    expect(
      createCommentAnchor('src/a.ts', {
        start: 2,
        side: 'deletions',
        end: 5,
        endSide: 'additions',
      })
    ).toEqual({
      line: 5,
      path: 'src/a.ts',
      side: 'RIGHT',
      startLine: 2,
      startSide: 'LEFT',
    });
  });
});

describe('readCommentAnchor', () => {
  test('reads a file-level anchor and ignores its line fields', () => {
    const anchor = readCommentAnchor({
      line: 1,
      path: 'src/a.ts',
      side: 'RIGHT',
      subjectType: 'file',
    });
    expect(anchor).toEqual({ path: 'src/a.ts', subjectType: 'file' });
    expect(anchor == null ? null : getAnchorRange(anchor)).toEqual(
      createFileCommentRange()
    );
  });

  test('rejects anchors without a path', () => {
    expect(readCommentAnchor({ subjectType: 'file' })).toBeNull();
    expect(readCommentAnchor({ line: 3, side: 'RIGHT' })).toBeNull();
  });
});
