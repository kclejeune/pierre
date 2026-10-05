import { describe, expect, test } from 'bun:test';

import {
  buildActivePullsVariables,
  buildBucketSearchQuery,
  isPullBucket,
  parseActivePullsPayload,
  parseRepoPullsPayload,
  parseSearchIssuesPayload,
} from '@/lib/githubPullSummaries';

function activeNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'PR_1',
    number: 7,
    title: 'Tune the warp core',
    isDraft: false,
    updatedAt: '2026-08-02T09:00:00Z',
    author: { login: 'octocat', avatarUrl: 'https://example.com/a.png' },
    repository: { name: 'bun', owner: { login: 'oven-sh' } },
    viewerLatestReview: null,
    viewerLatestReviewRequest: null,
    ...overrides,
  };
}

describe('buildActivePullsVariables', () => {
  test('scopes both searches identically and sorts by update', () => {
    expect(
      buildActivePullsVariables({ excludeRepos: ['ziglang/zig'] })
    ).toEqual({
      commentedQuery:
        'is:open is:pr archived:false commenter:@me -author:@me -repo:ziglang/zig sort:updated-desc',
      first: 25,
      query:
        'is:open is:pr archived:false (user-review-requested:@me OR commenter:@me OR reviewed-by:@me) -author:@me -repo:ziglang/zig sort:updated-desc',
    });
  });
});

describe('parseActivePullsPayload', () => {
  test('maps GraphQL nodes onto pull summaries', () => {
    const { pulls, totalCount } = parseActivePullsPayload({
      pulls: { issueCount: 3, nodes: [activeNode({ isDraft: true })] },
      commented: { nodes: [] },
    });
    expect(totalCount).toBe(3);
    expect(pulls).toEqual([
      {
        number: 7,
        title: 'Tune the warp core',
        owner: 'oven-sh',
        repo: 'bun',
        authorLogin: 'octocat',
        authorAvatarUrl: 'https://example.com/a.png',
        state: 'draft',
        updatedAt: '2026-08-02T09:00:00Z',
        viewerPath: '/oven-sh/bun/pull/7',
        activity: [],
      },
    ]);
  });

  test('derives viewer activity chips in display order', () => {
    const { pulls } = parseActivePullsPayload({
      pulls: {
        issueCount: 4,
        nodes: [
          activeNode({
            id: 'A',
            viewerLatestReview: { state: 'APPROVED' },
            viewerLatestReviewRequest: {
              requestedReviewer: { __typename: 'User' },
            },
          }),
          activeNode({
            id: 'B',
            viewerLatestReview: { state: 'CHANGES_REQUESTED' },
          }),
          activeNode({
            id: 'C',
            viewerLatestReview: { state: 'PENDING' },
            viewerLatestReviewRequest: {
              requestedReviewer: { __typename: 'Team' },
            },
          }),
          activeNode({ id: 'D', viewerLatestReview: { state: 'COMMENTED' } }),
        ],
      },
      commented: { nodes: [{ id: 'A' }, { id: 'C' }] },
    });
    expect(pulls.map((pull) => pull.activity)).toEqual([
      ['review-requested', 'approved', 'commented'],
      ['changes-requested'],
      ['team-review-requested', 'commented'],
      ['reviewed'],
    ]);
  });

  test('drops malformed nodes and tolerates missing searches', () => {
    expect(
      parseActivePullsPayload({
        pulls: { nodes: [{}, activeNode({ repository: null })] },
      })
    ).toEqual({ pulls: [], totalCount: 0 });
    expect(parseActivePullsPayload(null)).toEqual({
      pulls: [],
      totalCount: 0,
    });
  });
});

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
      'is:open is:pr archived:false user-review-requested:@me'
    );
    expect(buildBucketSearchQuery('active')).toBe(
      'is:open is:pr archived:false (user-review-requested:@me OR commenter:@me OR reviewed-by:@me) -author:@me'
    );
  });

  test('widens review requests to teams when asked', () => {
    expect(
      buildBucketSearchQuery('review-requested', { reviewRequests: 'teams' })
    ).toBe('is:open is:pr archived:false review-requested:@me');
    expect(buildBucketSearchQuery('active', { reviewRequests: 'teams' })).toBe(
      'is:open is:pr archived:false (review-requested:@me OR commenter:@me OR reviewed-by:@me) -author:@me'
    );
    // Buckets without a review-request qualifier ignore the toggle.
    expect(buildBucketSearchQuery('created', { reviewRequests: 'teams' })).toBe(
      'is:open is:pr archived:false author:@me'
    );
  });

  test('keeps the active OR group intact when scoped to a repo', () => {
    expect(buildBucketSearchQuery('active', { repo: 'oven-sh/bun' })).toBe(
      'is:open is:pr archived:false (user-review-requested:@me OR commenter:@me OR reviewed-by:@me) -author:@me repo:oven-sh/bun'
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
