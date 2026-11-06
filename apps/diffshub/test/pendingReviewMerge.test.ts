import { describe, expect, test } from 'bun:test';

import type { RemotePendingReview } from '@/lib/pendingReview';
import { mergePendingReview } from '@/lib/pendingReviewMerge';
import type { CommentAuthor, PendingReviewComment } from '@/lib/types';

const author: CommentAuthor = { avatarUrl: '', login: 'octocat' };
const SHA = 'a'.repeat(40);

const local = (
  overrides: Partial<PendingReviewComment>
): PendingReviewComment => ({
  author,
  commitId: SHA,
  key: 'restored-0',
  message: 'local text',
  path: 'src/a.ts',
  range: { start: 3, side: 'additions', end: 3, endSide: 'additions' },
  ...overrides,
});

const remote = (
  comments: RemotePendingReview['comments']
): RemotePendingReview => ({ commitId: SHA, comments, id: 'PRR_1' });

describe('mergePendingReview', () => {
  test("GitHub's text wins for a saved draft without a local edit", () => {
    const merged = mergePendingReview(
      [local({ remoteId: 'C1', message: 'old', syncedMessage: 'old' })],
      remote([
        {
          body: 'edited on GitHub',
          id: 'C1',
          line: 3,
          path: 'src/a.ts',
          side: 'RIGHT',
        },
      ]),
      author
    );
    expect(merged).toMatchObject([
      {
        message: 'edited on GitHub',
        remoteId: 'C1',
        syncedMessage: 'edited on GitHub',
      },
    ]);
  });

  test('an edit GitHub has not saved yet is kept for saving', () => {
    const merged = mergePendingReview(
      [local({ remoteId: 'C1', message: 'newer', syncedMessage: 'old' })],
      remote([
        { body: 'old', id: 'C1', line: 3, path: 'src/a.ts', side: 'RIGHT' },
      ]),
      author
    );
    expect(merged[0]).toMatchObject({ message: 'newer', syncedMessage: 'old' });
  });

  test('saved drafts gone from GitHub drop; unsaved ones stay', () => {
    const merged = mergePendingReview(
      [
        local({
          key: 'restored-0',
          remoteId: 'C1',
          syncedMessage: 'local text',
        }),
        local({ key: 'restored-1' }),
      ],
      null,
      author
    );
    expect(merged.map((entry) => entry.key)).toEqual(['restored-1']);
  });

  test("drafts started in GitHub's UI are added, multi-line on the left", () => {
    const merged = mergePendingReview(
      [],
      remote([
        {
          body: 'from GitHub',
          id: 'C2',
          line: 9,
          path: 'src/b.ts',
          side: 'LEFT',
          startLine: 7,
          startSide: 'LEFT',
        },
      ]),
      author
    );
    expect(merged).toEqual([
      {
        author,
        commitId: SHA,
        inReplyTo: undefined,
        key: 'remote-C2',
        message: 'from GitHub',
        path: 'src/b.ts',
        range: { start: 7, side: 'deletions', end: 9, endSide: 'deletions' },
        remoteId: 'C2',
        syncedMessage: 'from GitHub',
      },
    ]);
  });

  test('a file-level draft from GitHub gets the file-level range', () => {
    const [entry] = mergePendingReview(
      [],
      remote([
        {
          body: 'about the file',
          id: 'C3',
          path: 'src/c.ts',
          subjectType: 'file',
        },
      ]),
      author
    );
    expect(entry?.range).toEqual({
      start: 0,
      side: 'additions',
      end: 0,
      endSide: 'additions',
    });
  });
});
