import { describe, expect, test } from 'bun:test';

import type { PullSummary } from '@/lib/githubPullSummaries';
import { buildPullRows, groupPulls } from '@/lib/pullGroups';

function pull(
  repo: string,
  title: string,
  // null for a deleted ("ghost") author.
  authorLogin: string | null = 'renovate'
): PullSummary {
  return {
    authorLogin: authorLogin ?? undefined,
    number: 1,
    owner: 'acme',
    repo,
    state: 'open',
    title,
    updatedAt: '2026-11-18T00:00:00Z',
    viewerPath: `/acme/${repo}/pull/1`,
  };
}

describe('groupPulls', () => {
  test('folds same-title, same-author pulls where the first appeared', () => {
    const groups = groupPulls([
      pull('a', 'pin repoctl to 0.2.37'),
      pull('b', 'feat: real work', 'octocat'),
      pull('c', 'Pin repoctl to 0.2.37 '),
      pull('d', 'pin repoctl to 0.2.37', 'someone-else'),
    ]);
    expect(
      groups.map((group) => group.pulls.map((entry) => entry.repo))
    ).toEqual([['a', 'c'], ['b'], ['d']]);
  });

  test('never groups pulls without an author', () => {
    const groups = groupPulls([
      pull('a', 'same', null),
      pull('b', 'same', null),
    ]);
    expect(groups).toHaveLength(2);
  });

  test('lists leads, plus every pull of expanded groups', () => {
    const groups = groupPulls([
      pull('a', 'bump'),
      pull('b', 'bump'),
      pull('c', 'other', 'octocat'),
    ]);
    const rows = (expanded: Set<string>) =>
      buildPullRows(groups, expanded).map((row) => [
        row.pull.repo,
        row.lead,
        row.covers.map((entry) => entry.repo).join(''),
      ]);
    // A collapsed lead covers its whole group.
    expect(rows(new Set())).toEqual([
      ['a', true, 'ab'],
      ['c', true, 'c'],
    ]);
    expect(rows(new Set([groups[0].key]))).toEqual([
      ['a', true, 'a'],
      ['b', false, 'b'],
      ['c', true, 'c'],
    ]);
  });
});
