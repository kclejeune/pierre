import { describe, expect, test } from 'bun:test';

import {
  buildBucketSearchQuery,
  isPullBucket,
  parseRepoPullsPayload,
  parseSearchIssuesPayload,
} from '@/lib/githubPullSummaries';

function searchItem(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Fix the flux capacitor',
    updated_at: '2026-08-01T12:00:00Z',
    repository_url: 'https://api.github.com/repos/oven-sh/bun',
    user: { login: 'octocat', avatar_url: 'https://example.com/a.png' },
    ...overrides,
  };
}

describe('buildBucketSearchQuery', () => {
  test('maps each bucket to its @me qualifier', () => {
    expect(buildBucketSearchQuery('created')).toBe(
      'is:open is:pr archived:false author:@me'
    );
    expect(buildBucketSearchQuery('assigned')).toBe(
      'is:open is:pr archived:false assignee:@me'
    );
    expect(buildBucketSearchQuery('review-requested')).toBe(
      'is:open is:pr archived:false review-requested:@me'
    );
  });

  test('appends a repo qualifier when scoped to a pinned repo', () => {
    expect(buildBucketSearchQuery('created', { repo: 'oven-sh/bun' })).toBe(
      'is:open is:pr archived:false author:@me repo:oven-sh/bun'
    );
  });

  test('appends -repo qualifiers when excluding pinned repos', () => {
    expect(
      buildBucketSearchQuery('created', {
        excludeRepos: ['oven-sh/bun', 'ziglang/zig'],
      })
    ).toBe(
      'is:open is:pr archived:false author:@me -repo:oven-sh/bun -repo:ziglang/zig'
    );
  });

  test('isPullBucket rejects unknown values', () => {
    expect(isPullBucket('created')).toBe(true);
    expect(isPullBucket('closed')).toBe(false);
  });
});

describe('parseSearchIssuesPayload', () => {
  test('parses items with dotcom repository URLs', () => {
    const { pulls, totalCount } = parseSearchIssuesPayload({
      total_count: 87,
      items: [searchItem()],
    });
    expect(totalCount).toBe(87);
    expect(pulls).toEqual([
      {
        number: 42,
        title: 'Fix the flux capacitor',
        owner: 'oven-sh',
        repo: 'bun',
        authorLogin: 'octocat',
        authorAvatarUrl: 'https://example.com/a.png',
        state: 'open',
        updatedAt: '2026-08-01T12:00:00Z',
        viewerPath: '/oven-sh/bun/pull/42',
      },
    ]);
  });

  test('parses GHES-shaped repository URLs', () => {
    const { pulls } = parseSearchIssuesPayload({
      total_count: 1,
      items: [
        searchItem({
          repository_url: 'https://ghe.example.com/api/v3/repos/acme/widgets',
        }),
      ],
    });
    expect(pulls[0]?.owner).toBe('acme');
    expect(pulls[0]?.repo).toBe('widgets');
    expect(pulls[0]?.viewerPath).toBe('/acme/widgets/pull/42');
  });

  test('marks drafts and drops malformed items', () => {
    const { pulls } = parseSearchIssuesPayload({
      total_count: 3,
      items: [
        searchItem({ draft: true }),
        searchItem({ repository_url: 'not a url' }),
        searchItem({ number: 'not a number' }),
      ],
    });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]?.state).toBe('draft');
  });

  test('handles a malformed payload', () => {
    expect(parseSearchIssuesPayload(null)).toEqual({
      pulls: [],
      totalCount: 0,
    });
  });
});

describe('parseRepoPullsPayload', () => {
  test('uses the provided repo and tolerates missing users', () => {
    const pulls = parseRepoPullsPayload('acme', 'widgets', [
      {
        number: 7,
        title: 'Add widgets',
        updated_at: '2026-08-02T00:00:00Z',
        draft: false,
      },
    ]);
    expect(pulls).toEqual([
      {
        number: 7,
        title: 'Add widgets',
        owner: 'acme',
        repo: 'widgets',
        state: 'open',
        updatedAt: '2026-08-02T00:00:00Z',
        viewerPath: '/acme/widgets/pull/7',
      },
    ]);
  });

  test('returns nothing for a non-array payload', () => {
    expect(parseRepoPullsPayload('a', 'b', { message: 'Not Found' })).toEqual(
      []
    );
  });
});
