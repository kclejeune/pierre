import { describe, expect, test } from 'bun:test';

import {
  deriveSuggestQuery,
  filterPullSuggestions,
} from '../lib/diffUrlSuggestions';

describe('deriveSuggestQuery', () => {
  test('bare owner searches repo names', () => {
    expect(deriveSuggestQuery('kclejeune')).toEqual({
      kind: 'repos',
      owner: null,
      query: 'kclejeune',
    });
  });

  test('owner/partial scopes the search to the owner', () => {
    expect(deriveSuggestQuery('kclejeune/pie')).toEqual({
      kind: 'repos',
      owner: 'kclejeune',
      query: 'pie',
    });
    expect(deriveSuggestQuery('kclejeune/')).toEqual({
      kind: 'repos',
      owner: 'kclejeune',
      query: '',
    });
  });

  test('owner/repo# and owner/repo/ suggest pull requests', () => {
    expect(deriveSuggestQuery('kclejeune/pierre#')).toEqual({
      kind: 'pulls',
      owner: 'kclejeune',
      repo: 'pierre',
      filter: '',
    });
    expect(deriveSuggestQuery('kclejeune/pierre/10')).toEqual({
      kind: 'pulls',
      owner: 'kclejeune',
      repo: 'pierre',
      filter: '10',
    });
  });

  test('URLs, full paths, and hostnames are left alone', () => {
    expect(deriveSuggestQuery('https://github.com/a/b')).toBeNull();
    expect(deriveSuggestQuery('owner/repo/pull/123')).toBeNull();
    expect(deriveSuggestQuery('github.com')).toBeNull();
    expect(deriveSuggestQuery('')).toBeNull();
  });
});

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
