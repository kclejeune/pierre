import { describe, expect, test } from 'bun:test';

import { parsePullCommitsPage } from '../githubPullDetailsServer';
import {
  commitRangeViewerPath,
  type PullCommitSummary,
} from '../pullCommitsList';

const REPO = { owner: 'octo', repo: 'demo' };

function commit(sha: string, parentSha?: string): PullCommitSummary {
  return { headline: `commit ${sha}`, parentSha, sha };
}

// Oldest first, as GitHub lists pull commits: base is c1's parent "root".
const COMMITS = [
  commit('c1', 'base0'),
  commit('c2', 'c1'),
  commit('c3', 'c2'),
  commit('c4', 'c3'),
];

describe('commitRangeViewerPath', () => {
  test('a single commit opens its own commit diff', () => {
    expect(commitRangeViewerPath(REPO, COMMITS, 'c2', 'c2')).toBe(
      '/octo/demo/commit/c2'
    );
  });

  test('a range compares from the earliest selection parent to the latest', () => {
    expect(commitRangeViewerPath(REPO, COMMITS, 'c2', 'c4')).toBe(
      '/octo/demo/compare/c1...c4'
    );
  });

  test('selection order does not matter', () => {
    expect(commitRangeViewerPath(REPO, COMMITS, 'c4', 'c2')).toBe(
      '/octo/demo/compare/c1...c4'
    );
  });

  test('a range starting at the first commit spans from the pull base', () => {
    expect(commitRangeViewerPath(REPO, COMMITS, 'c1', 'c3')).toBe(
      '/octo/demo/compare/base0...c3'
    );
  });

  test('unknown shas and parentless starts return null', () => {
    expect(commitRangeViewerPath(REPO, COMMITS, 'nope', 'c3')).toBeNull();
    expect(
      commitRangeViewerPath(
        REPO,
        [commit('root'), commit('c2', 'root')],
        'root',
        'c2'
      )
    ).toBeNull();
  });
});

describe('parsePullCommitsPage', () => {
  test('narrows a pulls/{n}/commits page to the picker fields', () => {
    const commits = parsePullCommitsPage([
      {
        author: { avatar_url: 'https://a/o.png', login: 'octocat' },
        commit: {
          author: { date: '2026-01-02T03:04:05Z', name: 'Octo Cat' },
          message: 'Fix the thing\n\nLonger body here.',
        },
        parents: [{ sha: 'p1' }],
        sha: 'abc',
      },
      {
        // No resolved GitHub account: falls back to the raw author name.
        author: null,
        commit: { author: { name: 'Drive By' }, message: 'One-liner' },
        parents: [],
        sha: 'def',
      },
      { commit: { message: 'missing sha is skipped' } },
    ]);
    expect(commits).toEqual([
      {
        authorAvatarUrl: 'https://a/o.png',
        authorLogin: 'octocat',
        authoredAt: '2026-01-02T03:04:05Z',
        headline: 'Fix the thing',
        parentSha: 'p1',
        sha: 'abc',
      },
      {
        authorAvatarUrl: undefined,
        authorLogin: 'Drive By',
        authoredAt: undefined,
        headline: 'One-liner',
        parentSha: undefined,
        sha: 'def',
      },
    ]);
  });

  test('tolerates a malformed payload', () => {
    expect(parsePullCommitsPage(null)).toEqual([]);
    expect(parsePullCommitsPage({ commits: [] })).toEqual([]);
  });
});
