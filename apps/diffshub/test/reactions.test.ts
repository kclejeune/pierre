import { describe, expect, test } from 'bun:test';

import {
  readReactionGroups,
  readRestReactions,
  toggleReaction,
} from '@/lib/reactions';

describe('readRestReactions', () => {
  test('keeps non-zero tallies in picker order', () => {
    expect(
      readRestReactions({ total_count: 3, heart: 1, '+1': 2, eyes: 0 })
    ).toEqual([
      { content: '+1', count: 2, viewerHasReacted: false },
      { content: 'heart', count: 1, viewerHasReacted: false },
    ]);
    expect(readRestReactions(undefined)).toEqual([]);
  });
});

describe('readReactionGroups', () => {
  test('maps GraphQL enums and viewer state, dropping empty groups', () => {
    expect(
      readReactionGroups([
        {
          content: 'THUMBS_UP',
          reactors: { totalCount: 2 },
          viewerHasReacted: true,
        },
        {
          content: 'ROCKET',
          reactors: { totalCount: 0 },
          viewerHasReacted: false,
        },
      ])
    ).toEqual([{ content: '+1', count: 2, viewerHasReacted: true }]);
    expect(readReactionGroups(null)).toBeNull();
  });
});

describe('toggleReaction', () => {
  test('adds, increments, and removes the viewer reaction', () => {
    const added = toggleReaction([], 'rocket');
    expect(added).toEqual([
      { content: 'rocket', count: 1, viewerHasReacted: true },
    ]);
    expect(toggleReaction(added, 'rocket')).toEqual([]);
    expect(
      toggleReaction(
        [{ content: 'heart', count: 2, viewerHasReacted: false }],
        '+1'
      ).map((entry) => entry.content)
    ).toEqual(['+1', 'heart']);
    expect(
      toggleReaction(
        [{ content: 'heart', count: 2, viewerHasReacted: true }],
        'heart'
      )
    ).toEqual([{ content: 'heart', count: 1, viewerHasReacted: false }]);
  });
});
