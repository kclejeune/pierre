import { describe, expect, test } from 'bun:test';

import { filterPullSuggestions } from '../lib/diffUrlSuggestions';

describe('filterPullSuggestions', () => {
  const pulls = [
    { number: 12, title: 'Fix resize handling' },
    { number: 120, title: 'Add margin rail' },
    { number: 34, title: 'Docs cleanup' },
  ];

  test('digits narrow by number prefix', () => {
    expect(filterPullSuggestions(pulls, '12').map((p) => p.number)).toEqual([
      12, 120,
    ]);
  });

  test('text narrows by title', () => {
    expect(filterPullSuggestions(pulls, 'rail').map((p) => p.number)).toEqual([
      120,
    ]);
  });

  test('empty filter keeps everything', () => {
    expect(filterPullSuggestions(pulls, '')).toEqual(pulls);
  });
});
