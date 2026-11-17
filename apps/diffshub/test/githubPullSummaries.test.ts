import { describe, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from '../app/api/github-pulls/route';
import {
  ACCESS_FIELD_ERRORS,
  GitHubCommitError,
  sendGitHubGraphQL,
} from '@/lib/githubCommitServer';
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
    // The overlap accumulates across pages, but never past GitHub search's
    // 1,000-result cap, so anything larger isn't one this endpoint wrote.
    expect(
      decodePullsCursor(
        btoa(JSON.stringify(['abc', '2026-08-02T09:00:00Z', 500]))
      )?.boundaryRows
    ).toBe(500);
    expect(
      decodePullsCursor(
        btoa(JSON.stringify(['abc', '2026-08-02T09:00:00Z', 1001]))
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
    // A malformed color keeps the label; LabelColorDot just draws no swatch.
    expect(page.pulls[0].labels).toEqual([
      { name: 'bug', color: 'd73a4a' },
      { name: 'bad color', color: 'red' },
    ]);
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

  // The commented subset restarts at the boundary timestamp on every page,
  // so its overlap with shown rows keeps growing while pages share it.
  test('carries boundary rows across pages that share a timestamp', () => {
    const shared = '2026-08-01T00:00:00Z';
    const payload = {
      pulls: {
        issueCount: 90,
        pageInfo: { endCursor: 'Y3Vyc29y', hasNextPage: true },
        nodes: [
          activeNode({ id: 'A', updatedAt: shared }),
          activeNode({ id: 'B', updatedAt: shared }),
        ],
      },
    };
    const previous = {
      after: 'cHJldg',
      lastUpdatedAt: shared,
      boundaryRows: 25,
    };
    const page = parseActivePullsPayload(payload, previous);
    expect(decodePullsCursor(page.nextCursor ?? '')?.boundaryRows).toBe(27);
    // A newer row on the page starts the count again.
    expect(
      decodePullsCursor(
        parseActivePullsPayload(
          {
            pulls: {
              ...payload.pulls,
              nodes: [
                activeNode({ id: 'N', updatedAt: '2026-08-02T00:00:00Z' }),
                ...payload.pulls.nodes,
              ],
            },
          },
          previous
        ).nextCursor ?? ''
      )?.boundaryRows
    ).toBe(2);
    // The subset widens by the whole overlap, up to GraphQL's page limit.
    const cursor = { ...previous, boundaryRows: 50 };
    expect(
      buildActivePullsVariables({ involves: [], text: OPEN }, cursor)
        .commentedFirst
    ).toBe(75);
    expect(
      buildActivePullsVariables(
        { involves: [], text: OPEN },
        { ...cursor, boundaryRows: 200 }
      ).commentedFirst
    ).toBe(100);
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

  // A page whose every hit the GitHub App can't read is read past, so the
  // dashboard never receives an empty page while readable rows follow.
  test('reads past pages with only unreadable hits', async () => {
    const afters: unknown[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(init?.body as string) as {
        variables: { after?: string };
      };
      afters.push(body.variables.after);
      const unreadable = body.variables.after == null;
      return Promise.resolve(
        Response.json({
          data: {
            pulls: {
              issueCount: 26,
              pageInfo: {
                endCursor: unreadable ? 'cDI' : null,
                hasNextPage: unreadable,
              },
              nodes: unreadable ? Array(25).fill(null) : [activeNode()],
            },
          },
          errors: unreadable
            ? Array.from({ length: 25 }, (_, index) => ({
                type: 'FORBIDDEN',
                path: ['pulls', 'nodes', index],
                message: 'Resource not accessible by integration',
              }))
            : undefined,
        })
      );
    }) as typeof fetch);
    try {
      const response = await GET(
        new NextRequest('https://diffshub.test/api/github-pulls?q=is%3Aopen', {
          headers: { Authorization: 'Bearer ghu_token' },
        })
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        nextCursor?: string;
        pulls: { number: number }[];
      };
      expect(body.pulls.map((pull) => pull.number)).toEqual([7]);
      expect(body.nextCursor).toBeUndefined();
      expect(afters).toEqual([undefined, 'cDI']);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// Mirrors the pulls route: hits in repos the GitHub App can't read come back
// as null nodes with path-scoped access errors.
describe('search hits the GitHub App cannot read', () => {
  const tolerate = {
    types: ACCESS_FIELD_ERRORS,
    paths: [
      ['pulls', 'nodes'],
      ['commented', 'nodes'],
    ],
  };
  const respond = (errors: unknown[]) => () =>
    Promise.resolve(
      Response.json({
        data: {
          pulls: {
            issueCount: 2,
            pageInfo: { endCursor: null, hasNextPage: false },
            nodes: [activeNode(), null],
          },
        },
        errors,
      })
    );
  const hidden = {
    type: 'FORBIDDEN',
    path: ['pulls', 'nodes', 1],
    message: 'Resource not accessible by integration',
  };

  test('a page with hidden hits keeps the readable rows', async () => {
    const data = await sendGitHubGraphQL(
      'q',
      {},
      'ghu_token',
      respond([hidden]),
      {
        tolerate,
      }
    );
    expect(
      parseActivePullsPayload(data).pulls.map((pull) => pull.number)
    ).toEqual([7]);
    // Without the tolerance the same answer fails the whole request.
    const strict = await sendGitHubGraphQL(
      'q',
      {},
      'ghu_token',
      respond([hidden])
    ).catch((thrown: unknown) => thrown);
    expect(String(strict)).toContain("The DiffsHub GitHub App can't access");
  });

  test.each([
    ['on the search itself', { type: 'FORBIDDEN', path: ['pulls'] }],
    ['without a path', { type: 'FORBIDDEN' }],
    ['of another type', { type: 'INTERNAL', path: ['pulls', 'nodes', 0] }],
  ])('an error %s still fails the page', async (_name, error) => {
    const thrown = await sendGitHubGraphQL(
      'q',
      {},
      'ghu_token',
      respond([hidden, error]),
      { tolerate }
    ).catch((caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(GitHubCommitError);
  });

  // Unreadable hits are null nodes: no timestamp, but still paged past.
  const page = (nodes: unknown[], hasNextPage = true) => ({
    pulls: {
      issueCount: 100,
      pageInfo: { endCursor: 'bmV4dA', hasNextPage },
      nodes,
    },
  });
  const shared = '2026-08-01T00:00:00Z';

  test('a page of only unreadable hits still pages on', () => {
    const first = parseActivePullsPayload(page(Array(25).fill(null)));
    expect(first.pulls).toEqual([]);
    const cursor = decodePullsCursor(first.nextCursor ?? '');
    // No readable row yet: no bound, and every hit so far is overlap.
    expect(cursor).toEqual({
      after: 'bmV4dA',
      lastUpdatedAt: undefined,
      boundaryRows: 25,
    });
    const variables = buildActivePullsVariables(
      { involves: [], text: OPEN },
      cursor
    );
    expect(variables.withCommented).toBe(true);
    expect(variables.commentedQuery).not.toContain('updated:');
    expect(variables.commentedFirst).toBe(50);

    // Later, an all-unreadable page keeps the bound and adds to the overlap.
    const later = parseActivePullsPayload(page(Array(25).fill(null)), {
      after: 'cHJldg',
      lastUpdatedAt: shared,
      boundaryRows: 3,
    });
    expect(decodePullsCursor(later.nextCursor ?? '')).toEqual({
      after: 'bmV4dA',
      lastUpdatedAt: shared,
      boundaryRows: 28,
    });
  });

  test('unreadable hits after the boundary row count as overlap', () => {
    const result = parseActivePullsPayload(
      page([
        activeNode({ id: 'A', updatedAt: '2026-08-02T00:00:00Z' }),
        activeNode({ id: 'B', updatedAt: shared }),
        ...Array(23).fill(null),
      ])
    );
    const cursor = decodePullsCursor(result.nextCursor ?? '');
    expect(cursor?.lastUpdatedAt).toBe(shared);
    expect(cursor?.boundaryRows).toBe(24);
    expect(
      buildActivePullsVariables({ involves: [], text: OPEN }, cursor)
        .commentedFirst
    ).toBe(49);
  });
});
