import { describe, expect, test } from 'bun:test';

import {
  buildActivePullsVariables,
  buildActiveSearchQuery,
  involvementsUseReviewRequests,
  parseActivePullsPayload,
  parsePullInvolvements,
  parseRepoPullsPayload,
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
  // The commented subset narrows the main search, so every commented row on
  // the main page is also in the subset's page.
  test('scopes both searches identically and sorts by update', () => {
    expect(
      buildActivePullsVariables({
        excludeRepos: ['ziglang/zig'],
        involves: ['assigned'],
      })
    ).toEqual({
      commentedQuery:
        'is:open is:pr archived:false assignee:@me commenter:@me -author:@me -repo:ziglang/zig sort:updated-desc',
      first: 25,
      query:
        'is:open is:pr archived:false assignee:@me -repo:ziglang/zig sort:updated-desc',
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
          activeNode({
            id: 'E',
            assignees: { nodes: [{ isViewer: false }, { isViewer: true }] },
            viewerLatestReviewRequest: {
              requestedReviewer: { __typename: 'User' },
            },
          }),
          // The viewer's own pull: thread replies leave a COMMENTED review,
          // which must not read as reviewing it.
          activeNode({
            id: 'F',
            viewerDidAuthor: true,
            viewerLatestReview: { state: 'COMMENTED' },
            assignees: { nodes: [{ isViewer: true }] },
          }),
        ],
      },
      commented: { nodes: [{ id: 'A' }, { id: 'C' }] },
    });
    expect(pulls.map((pull) => pull.activity)).toEqual([
      ['review-requested', 'approved', 'commented'],
      ['changes-requested'],
      ['team-review-requested', 'commented'],
      ['reviewed'],
      ['review-requested', 'assigned'],
      ['authored', 'assigned'],
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

describe('buildActiveSearchQuery', () => {
  test('ORs every involvement by default', () => {
    expect(buildActiveSearchQuery({ involves: [] })).toBe(
      'is:open is:pr archived:false (user-review-requested:@me OR author:@me OR (reviewed-by:@me -author:@me) OR (commenter:@me -author:@me) OR assignee:@me)'
    );
  });

  test('narrows to the selected involvements', () => {
    expect(buildActiveSearchQuery({ involves: ['authored'] })).toBe(
      'is:open is:pr archived:false author:@me'
    );
    expect(
      buildActiveSearchQuery({ involves: ['reviewed', 'commented'] })
    ).toBe(
      'is:open is:pr archived:false ((reviewed-by:@me -author:@me) OR (commenter:@me -author:@me))'
    );
    // Only reviewing and commenting skip own pulls; a self-assigned pull
    // still lists under Assigned.
    expect(buildActiveSearchQuery({ involves: ['assigned'] })).toBe(
      'is:open is:pr archived:false assignee:@me'
    );
  });

  test('widens review requests to teams when asked', () => {
    expect(
      buildActiveSearchQuery({
        involves: ['review-requested'],
        reviewRequests: 'teams',
      })
    ).toBe('is:open is:pr archived:false review-requested:@me');
  });

  test('scopes to a pinned repo or excludes pinned repos', () => {
    expect(
      buildActiveSearchQuery({
        involves: ['review-requested', 'commented'],
        repo: 'oven-sh/bun',
      })
    ).toBe(
      'is:open is:pr archived:false (user-review-requested:@me OR (commenter:@me -author:@me)) repo:oven-sh/bun'
    );
    expect(
      buildActiveSearchQuery({
        involves: ['authored'],
        excludeRepos: ['oven-sh/bun', 'ziglang/zig'],
      })
    ).toBe(
      'is:open is:pr archived:false author:@me -repo:oven-sh/bun -repo:ziglang/zig'
    );
  });
});

describe('parsePullInvolvements', () => {
  test('canonicalizes order, drops duplicates, and rejects unknowns', () => {
    expect(parsePullInvolvements(null)).toEqual([]);
    expect(parsePullInvolvements('')).toEqual([]);
    expect(parsePullInvolvements('assigned,authored,assigned')).toEqual([
      'authored',
      'assigned',
    ]);
    expect(parsePullInvolvements('authored,closed')).toBeUndefined();
  });

  test('folds a full selection into the empty "all" selection', () => {
    expect(
      parsePullInvolvements(
        'review-requested,authored,reviewed,commented,assigned'
      )
    ).toEqual([]);
  });

  test('only selections with a review-request term use the teams switch', () => {
    expect(involvementsUseReviewRequests([])).toBe(true);
    expect(involvementsUseReviewRequests(['review-requested'])).toBe(true);
    expect(involvementsUseReviewRequests(['authored'])).toBe(false);
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
