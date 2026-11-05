import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from '../app/api/github-pulls/route';
import {
  buildActivePullsVariables,
  buildActiveSearchQuery,
  decodePullsCursor,
  encodePullsCursor,
  involvementsUseReviewRequests,
  parseActivePullsPayload,
  parsePullInvolvements,
} from '@/lib/githubPullSummaries';

// The query bar's default text.
const OPEN = 'is:open';

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
        repos: ['ziglang/zig'],
        involves: ['assigned'],
        text: OPEN,
      })
    ).toEqual({
      commentedFirst: 25,
      commentedQuery:
        'is:open is:pr archived:false assignee:@me commenter:@me -author:@me repo:ziglang/zig sort:updated-desc',
      first: 25,
      query:
        'is:open is:pr archived:false assignee:@me repo:ziglang/zig sort:updated-desc',
      withCommented: true,
    });
  });

  test('moves a typed sort to the end of both searches', () => {
    const variables = buildActivePullsVariables({
      involves: 'anyone',
      repos: ['oven-sh/bun'],
      text: 'sort:created-asc is:open label:bug',
    });
    expect(variables.query).toBe(
      'is:open label:bug is:pr archived:false repo:oven-sh/bun sort:created-asc'
    );
    expect(variables.commentedQuery).toBe(
      'is:open label:bug is:pr archived:false commenter:@me -author:@me repo:oven-sh/bun sort:created-asc'
    );
  });

  // The subset can't reuse the main search's cursor, so later pages bound it
  // by the previous page's last update instead.
  test('bounds the commented subset on later pages by the last update', () => {
    const cursor = {
      after: 'Y3Vyc29y',
      lastUpdatedAt: '2026-08-02T09:00:00Z',
      boundaryRows: 1,
    };
    const variables = buildActivePullsVariables(
      { involves: [], text: OPEN },
      cursor
    );
    expect(variables.after).toBe('Y3Vyc29y');
    expect(variables.withCommented).toBe(true);
    // The inclusive bound can return the previous page's last row too, so
    // the subset fetches one extra to keep this page's last row in it.
    expect(variables.commentedFirst).toBe(26);
    expect(variables.commentedQuery).toContain(
      'commenter:@me -author:@me updated:<=2026-08-02T09:00:00Z'
    );
    expect(
      buildActivePullsVariables(
        { involves: [], text: 'is:open sort:updated-asc' },
        cursor
      ).commentedQuery
    ).toContain('updated:>=2026-08-02T09:00:00Z');
    // No bound exists for other orders, so the subset is skipped.
    expect(
      buildActivePullsVariables(
        { involves: [], text: 'is:open sort:created-desc' },
        cursor
      ).withCommented
    ).toBe(false);
  });

  test('skips the commented subset when only authored pulls are selected', () => {
    expect(
      buildActivePullsVariables({ involves: ['authored'] }).withCommented
    ).toBe(false);
    expect(buildActivePullsVariables({ involves: [] }).withCommented).toBe(
      true
    );
    expect(
      buildActivePullsVariables({ involves: 'anyone' }).withCommented
    ).toBe(true);
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
    expect(buildActiveSearchQuery({ involves: [], text: OPEN })).toBe(
      'is:open is:pr archived:false (user-review-requested:@me OR author:@me OR (reviewed-by:@me -author:@me) OR (commenter:@me -author:@me) OR assignee:@me)'
    );
  });

  test('narrows to the selected involvements', () => {
    expect(buildActiveSearchQuery({ involves: ['authored'], text: OPEN })).toBe(
      'is:open is:pr archived:false author:@me'
    );
    expect(
      buildActiveSearchQuery({
        involves: ['reviewed', 'commented'],
        text: OPEN,
      })
    ).toBe(
      'is:open is:pr archived:false ((reviewed-by:@me -author:@me) OR (commenter:@me -author:@me))'
    );
    // Only reviewing and commenting skip own pulls; a self-assigned pull
    // still lists under Assigned.
    expect(buildActiveSearchQuery({ involves: ['assigned'], text: OPEN })).toBe(
      'is:open is:pr archived:false assignee:@me'
    );
  });

  test('widens review requests to teams when asked', () => {
    expect(
      buildActiveSearchQuery({
        involves: ['review-requested'],
        reviewRequests: 'teams',
        text: OPEN,
      })
    ).toBe('is:open is:pr archived:false review-requested:@me');
  });

  test('scopes to one repository or ORs several', () => {
    expect(
      buildActiveSearchQuery({
        involves: ['review-requested', 'commented'],
        repos: ['oven-sh/bun'],
        text: OPEN,
      })
    ).toBe(
      'is:open is:pr archived:false (user-review-requested:@me OR (commenter:@me -author:@me)) repo:oven-sh/bun'
    );
    expect(
      buildActiveSearchQuery({
        involves: ['authored'],
        repos: ['oven-sh/bun', 'ziglang/zig'],
        text: OPEN,
      })
    ).toBe(
      'is:open is:pr archived:false author:@me (repo:oven-sh/bun OR repo:ziglang/zig)'
    );
  });

  test('drops the involvement terms for anyone', () => {
    expect(
      buildActiveSearchQuery({
        involves: 'anyone',
        repos: ['oven-sh/bun'],
        text: OPEN,
      })
    ).toBe('is:open is:pr archived:false repo:oven-sh/bun');
  });

  test('keeps the typed text intact, grouping its own ORs', () => {
    expect(
      buildActiveSearchQuery({
        involves: 'anyone',
        repos: ['oven-sh/bun'],
        text: 'label:bug OR label:"good first issue"',
      })
    ).toBe(
      '(label:bug OR label:"good first issue") is:pr archived:false repo:oven-sh/bun'
    );
    // An empty bar lists every state, as on GitHub.
    expect(buildActiveSearchQuery({ involves: ['authored'], text: '' })).toBe(
      'is:pr archived:false author:@me'
    );
  });

  test('leaves archived repos to the typed text when it mentions them', () => {
    expect(
      buildActiveSearchQuery({ involves: ['authored'], text: 'archived:true' })
    ).toBe('archived:true is:pr author:@me');
  });
});

describe('pull page cursors', () => {
  test('round-trip and reject anything else', () => {
    const cursor = {
      after: 'abc==',
      lastUpdatedAt: '2026-08-02T09:00:00Z',
      boundaryRows: 2,
    };
    expect(decodePullsCursor(encodePullsCursor(cursor))).toEqual(cursor);
    expect(decodePullsCursor('not base64 json')).toBeUndefined();
    expect(
      decodePullsCursor(btoa(JSON.stringify(['abc', 'yesterday', 1])))
    ).toBeUndefined();
    // An overlap larger than a page isn't one this endpoint wrote.
    expect(
      decodePullsCursor(
        btoa(JSON.stringify(['abc', '2026-08-02T09:00:00Z', 500]))
      )
    ).toBeUndefined();
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

describe('parseActivePullsPayload page details', () => {
  test('reads merged/closed state, labels, and the next-page cursor', () => {
    const page = parseActivePullsPayload({
      pulls: {
        issueCount: 60,
        pageInfo: { endCursor: 'Y3Vyc29y', hasNextPage: true },
        nodes: [
          activeNode({
            id: 'A',
            state: 'MERGED',
            isDraft: true,
            labels: {
              nodes: [
                { name: 'bug', color: 'd73a4a' },
                { name: 'bad color', color: 'red' },
              ],
            },
          }),
          activeNode({
            id: 'B',
            state: 'CLOSED',
            updatedAt: '2026-08-01T00:00:00Z',
          }),
        ],
      },
    });
    expect(page.pulls.map((pull) => pull.state)).toEqual(['merged', 'closed']);
    expect(page.pulls[0].labels).toEqual([{ name: 'bug', color: 'd73a4a' }]);
    expect(page.pulls[1].labels).toBeUndefined();
    expect(decodePullsCursor(page.nextCursor ?? '')).toEqual({
      after: 'Y3Vyc29y',
      lastUpdatedAt: '2026-08-01T00:00:00Z',
      boundaryRows: 1,
    });
  });

  test('counts every shown row sharing the boundary timestamp', () => {
    const page = parseActivePullsPayload({
      pulls: {
        issueCount: 60,
        pageInfo: { endCursor: 'Y3Vyc29y', hasNextPage: true },
        nodes: [
          activeNode({ id: 'A', updatedAt: '2026-08-02T00:00:00Z' }),
          activeNode({ id: 'B', updatedAt: '2026-08-01T00:00:00Z' }),
          activeNode({ id: 'C', updatedAt: '2026-08-01T00:00:00Z' }),
        ],
      },
    });
    expect(decodePullsCursor(page.nextCursor ?? '')?.boundaryRows).toBe(2);
  });

  test('omits the cursor on the last page', () => {
    const page = parseActivePullsPayload({
      pulls: {
        issueCount: 1,
        pageInfo: { endCursor: 'Y3Vyc29y', hasNextPage: false },
        nodes: [activeNode()],
      },
    });
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('GET /api/github-pulls', () => {
  const list = (query: string) =>
    GET(new NextRequest(`https://diffshub.test/api/github-pulls?${query}`));

  test('anyone needs a repository scope or a narrowing qualifier', async () => {
    const unscoped = await list('involves=anyone&q=is%3Aopen');
    expect(unscoped.status).toBe(400);
    // Both narrowings get past validation (to the token check).
    expect((await list('involves=anyone&repos=acme%2Fwidgets')).status).toBe(
      401
    );
    expect((await list('involves=anyone&q=org%3Aacme')).status).toBe(401);
  });
});
