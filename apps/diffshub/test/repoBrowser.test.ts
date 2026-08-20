import { describe, expect, test } from 'bun:test';

import { buildComparePath, splitKnownRepoRef } from '../lib/repoBrowser';

describe('buildComparePath', () => {
  const repo = { owner: 'acme', repo: 'widgets' };

  test('names both ends with the three-dot separator', () => {
    expect(buildComparePath(repo, 'main', 'feat/thing')).toBe(
      '/acme/widgets/compare/main...feat/thing'
    );
  });

  test("a null base emits GitHub's compare-against-default shorthand", () => {
    expect(buildComparePath(repo, null, 'topic')).toBe(
      '/acme/widgets/compare/topic'
    );
  });
});

describe('splitKnownRepoRef', () => {
  test('empty remainder is the default-branch root', () => {
    expect(splitKnownRepoRef('')).toEqual({ ref: '', path: '' });
  });

  test('splits pull refs regardless of the path shape', () => {
    expect(splitKnownRepoRef('refs/pull/41/head')).toEqual({
      ref: 'refs/pull/41/head',
      path: '',
    });
    expect(splitKnownRepoRef('refs/pull/41/head/docs/guide.md')).toEqual({
      ref: 'refs/pull/41/head',
      path: 'docs/guide.md',
    });
    expect(splitKnownRepoRef('refs/pull/7/merge/a.ts')).toEqual({
      ref: 'refs/pull/7/merge',
      path: 'a.ts',
    });
  });

  test('splits sha-like first segments', () => {
    expect(splitKnownRepoRef('deadbeef1/src/index.ts')).toEqual({
      ref: 'deadbeef1',
      path: 'src/index.ts',
    });
  });

  test('single segments are a bare ref', () => {
    expect(splitKnownRepoRef('main')).toEqual({ ref: 'main', path: '' });
  });

  test('slash-containing branch candidates defer to the server', () => {
    expect(splitKnownRepoRef('main/docs/guide.md')).toBeNull();
    expect(splitKnownRepoRef('feat/thing/a.ts')).toBeNull();
  });
});
