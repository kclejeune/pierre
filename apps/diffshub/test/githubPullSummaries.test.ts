import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
import { pullsPageCache } from '@/lib/pullsPageCache';

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
      unmutedQuery:
        'is:open is:pr archived:false assignee:@me repo:ziglang/zig',
      withCommented: true,
      withUnmuted: false,
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
        nodeId: 'PR_1',
      },
    ]);
  });

  test('reads the head commit so the preview can prefetch its details', () => {
    const sha = 'a'.repeat(40);
    const { pulls } = parseActivePullsPayload({
      pulls: { issueCount: 1, nodes: [activeNode({ headRefOid: sha })] },
      commented: { nodes: [] },
    });
    expect(pulls[0]?.headSha).toBe(sha);
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
    ).toEqual({ pulls: [], hiddenCount: 0, totalCount: 0 });
    expect(parseActivePullsPayload(null)).toEqual({
      pulls: [],
      hiddenCount: 0,
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
  // Each test searches afresh, not from an earlier test's cached page.
  beforeEach(() => pullsPageCache.clear());
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
  test('answers a repeat search from the short-lived page cache', async () => {
    let searches = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(init?.body as string) as { query: string };
      if (body.query.includes('commented: search')) {
        return Promise.resolve(
          Response.json({ data: { commented: { nodes: [] } } })
        );
      }
      searches += 1;
      return Promise.resolve(
        Response.json({
          data: {
            pulls: {
              issueCount: 1,
              pageInfo: { endCursor: null, hasNextPage: false },
              nodes: [activeNode()],
            },
          },
        })
      );
    }) as typeof fetch);
    const search = (headers: Record<string, string> = {}) =>
      GET(
        new NextRequest('https://diffshub.test/api/github-pulls?q=is%3Aopen', {
          headers: { Authorization: 'Bearer ghu_token', ...headers },
        })
      );
    try {
      expect((await search()).status).toBe(200);
      expect(searches).toBe(1);
      // A fresh cached page answers without searching again.
      const repeat = (await (await search()).json()) as { stale?: boolean };
      expect(searches).toBe(1);
      expect(repeat.stale).toBeUndefined();
      // fetch()'s cache: 'reload' sends no-cache, which searches afresh.
      expect((await search({ 'Cache-Control': 'no-cache' })).status).toBe(200);
      expect(searches).toBe(2);
      // Past the fresh window, the cached page answers flagged stale and
      // uncacheable, so the client refetches it with no-cache.
      const realNow = Date.now;
      Date.now = () => realNow() + 30_000;
      try {
        const old = await search();
        expect(old.headers.get('Cache-Control')).toBe('private, max-age=0');
        expect(((await old.json()) as { stale?: boolean }).stale).toBe(true);
        expect(searches).toBe(2);
      } finally {
        Date.now = realNow;
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('a stale cached later page searches afresh', async () => {
    let searches = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(init?.body as string) as { query: string };
      if (body.query.includes('commented: search')) {
        return Promise.resolve(
          Response.json({ data: { commented: { nodes: [] } } })
        );
      }
      searches += 1;
      return Promise.resolve(
        Response.json({
          data: {
            pulls: {
              issueCount: 1,
              pageInfo: { endCursor: null, hasNextPage: false },
              nodes: [activeNode()],
            },
          },
        })
      );
    }) as typeof fetch);
    const cursor = encodeURIComponent(
      encodePullsCursor({ after: 'Y3Vyc29y', boundaryRows: 0 })
    );
    const loadMore = () =>
      GET(
        new NextRequest(
          `https://diffshub.test/api/github-pulls?q=is%3Aopen&cursor=${cursor}`,
          { headers: { Authorization: 'Bearer ghu_token' } }
        )
      );
    try {
      await loadMore();
      expect(searches).toBe(1);
      const realNow = Date.now;
      Date.now = () => realNow() + 30_000;
      try {
        // Load-more pages are appended as they come, never revalidated, so
        // one past the fresh window isn't served stale.
        const again = (await (await loadMore()).json()) as { stale?: boolean };
        expect(searches).toBe(2);
        expect(again.stale).toBeUndefined();
      } finally {
        Date.now = realNow;
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('reads past pages with only unreadable hits', async () => {
    const afters: unknown[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(init?.body as string) as {
        query: string;
        variables: { after?: string };
      };
      // The commented subset goes out beside each page's search.
      if (body.query.includes('commented: search')) {
        return Promise.resolve(
          Response.json({ data: { commented: { nodes: [] } } })
        );
      }
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
        hiddenCount: number;
        nextCursor?: string;
        pulls: { number: number }[];
      };
      expect(body.pulls.map((pull) => pull.number)).toEqual([7]);
      // The skipped page's hits are reported for the dashboard's empty state.
      expect(body.hiddenCount).toBe(25);
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
    expect(first.hiddenCount).toBe(25);
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

describe('muted authors', () => {
  const muted = ['app/renovate', 'svc-bump'];

  test('excludes muted authors from both searches', () => {
    const variables = buildActivePullsVariables({
      involves: ['review-requested'],
      mutedAuthors: muted,
      text: OPEN,
    });
    expect(variables.query).toBe(
      'is:open is:pr archived:false user-review-requested:@me -author:app/renovate -author:svc-bump sort:updated-desc'
    );
    expect(variables.commentedQuery).toContain(
      '-author:app/renovate -author:svc-bump'
    );
    // The first page counts the same search without the exclusions.
    expect(variables.unmutedQuery).toBe(
      'is:open is:pr archived:false user-review-requested:@me'
    );
    expect(variables.withUnmuted).toBe(true);
  });

  test('later pages skip the muted count', () => {
    const variables = buildActivePullsVariables(
      { involves: [], mutedAuthors: muted, text: OPEN },
      { after: 'cDI', lastUpdatedAt: '2026-08-02T09:00:00Z', boundaryRows: 0 }
    );
    expect(variables.query).toContain('-author:svc-bump');
    expect(variables.withUnmuted).toBe(false);
  });

  // Typing author:app/renovate is how the viewer triages a muted bot's
  // pulls; excluding it as well would match nothing.
  test("a typed author: qualifier lifts that author's exclusion", () => {
    const variables = buildActivePullsVariables({
      involves: [],
      mutedAuthors: muted,
      text: 'is:open author:App/Renovate',
    });
    expect(variables.query).not.toContain('-author:app/renovate');
    expect(variables.query).toContain('-author:svc-bump');
    // A quoted value names the same author.
    expect(
      buildActivePullsVariables({
        involves: [],
        mutedAuthors: muted,
        text: 'is:open author:"svc-bump"',
      }).query
    ).not.toContain('-author:svc-bump');
    expect(
      buildActivePullsVariables({
        involves: [],
        mutedAuthors: ['app/renovate'],
        text: 'is:open author:app/renovate',
      }).withUnmuted
    ).toBe(false);
    // A negated author term is the viewer's own exclusion, not a request.
    expect(
      buildActiveSearchQuery({
        involves: ['authored'],
        mutedAuthors: ['svc-bump'],
        text: 'is:open -author:octocat',
      })
    ).toBe(
      'is:open -author:octocat is:pr archived:false author:@me -author:svc-bump'
    );
  });

  // Only an author the text asks for lifts its exclusion; one it negates,
  // by NOT or inside a negated group, still needs the global exclusion.
  test('a negated author term keeps the exclusion', () => {
    const query = (text: string) =>
      buildActiveSearchQuery({
        involves: ['authored'],
        mutedAuthors: ['svc-bump'],
        text,
      });
    for (const text of [
      'is:open (NOT author:svc-bump OR label:dependencies)',
      'is:open -(author:svc-bump OR label:x)',
      'is:open -author:svc-bump',
      // Unbalanced parens have no reliable reading.
      'is:open (author:svc-bump',
    ]) {
      expect(query(text)).toEndWith('-author:svc-bump');
    }
    // Two negations cancel: the inner term asks for svc-bump.
    expect(query('is:open NOT (label:x -author:svc-bump)')).not.toEndWith(
      '-author:svc-bump'
    );
    expect(query('is:open (author:svc-bump OR label:x)')).not.toEndWith(
      '-author:svc-bump'
    );
  });

  test('reports how many pulls muting hid', () => {
    const page = parseActivePullsPayload({
      pulls: { issueCount: 4, nodes: [activeNode()] },
      unmuted: { issueCount: 30 },
    });
    expect(page.mutedCount).toBe(26);
    // The searches run a moment apart; the difference never goes negative.
    expect(
      parseActivePullsPayload({
        pulls: { issueCount: 4, nodes: [activeNode()] },
        unmuted: { issueCount: 3 },
      }).mutedCount
    ).toBe(0);
    expect(
      parseActivePullsPayload({
        pulls: { issueCount: 4, nodes: [activeNode()] },
      }).mutedCount
    ).toBeUndefined();
  });

  test('marks GitHub App authors as bots', () => {
    const { pulls } = parseActivePullsPayload({
      pulls: {
        issueCount: 2,
        nodes: [
          activeNode({
            id: 'A',
            author: { __typename: 'Bot', login: 'renovate', avatarUrl: '' },
          }),
          activeNode({
            id: 'B',
            number: 8,
            author: { __typename: 'User', login: 'octocat', avatarUrl: '' },
          }),
        ],
      },
    });
    expect(pulls.map((pull) => pull.authorIsBot)).toEqual([true, undefined]);
  });

  test('the route validates ?mute=', async () => {
    const list = (query: string) =>
      GET(new NextRequest(`https://diffshub.test/api/github-pulls?${query}`));
    expect((await list('mute=app%2Frenovate,svc-bump')).status).toBe(401);
    expect((await list('mute=renovate%20OR%20x')).status).toBe(400);
    expect((await list('mute=app%2F')).status).toBe(400);
    const tooMany = Array.from({ length: 21 }, (_, index) => `u${index}`);
    expect((await list(`mute=${tooMany.join(',')}`)).status).toBe(400);
  });
});

describe('muted branches and stale pulls', () => {
  test('adds -head: exclusions and the staleness cutoff on open searches', () => {
    const variables = buildActivePullsVariables({
      involves: ['authored'],
      mutedBranches: ['renovate', 'dependabot'],
      staleCutoff: '2026-09-20',
      text: OPEN,
    });
    expect(variables.query).toBe(
      'is:open is:pr archived:false author:@me -head:renovate -head:dependabot updated:>=2026-09-20 sort:updated-desc'
    );
    // The hidden count is everything muting removed, staleness included.
    expect(variables.unmutedQuery).toBe(
      'is:open is:pr archived:false author:@me'
    );
    expect(variables.withUnmuted).toBe(true);
  });

  test('mutedOnly lists what muting would leave out, as one OR group', () => {
    const variables = buildActivePullsVariables({
      involves: 'anyone',
      mutedAuthors: ['app/renovate'],
      mutedBranches: ['dependabot'],
      mutedOnly: true,
      staleCutoff: '2026-09-20',
      text: OPEN,
    });
    expect(variables.query).toBe(
      'is:open is:pr archived:false (author:app/renovate OR head:dependabot OR updated:<2026-09-20) sort:updated-desc'
    );
    // Nothing is hidden, so there's no muted count to take.
    expect(variables.withUnmuted).toBe(false);
    // One rule needs no group; a typed author: lifts that author as usual.
    expect(
      buildActiveSearchQuery({
        involves: 'anyone',
        mutedAuthors: ['app/renovate', 'svc-bump'],
        mutedOnly: true,
        text: 'is:open author:svc-bump',
      })
    ).toBe('is:open author:svc-bump is:pr archived:false author:app/renovate');
  });

  test('the route answers mutedOnly with nothing muted as an empty page', async () => {
    const body = { hiddenCount: 0, pulls: [], totalCount: 0 };
    const list = (query: string) =>
      GET(
        new NextRequest(`https://diffshub.test/api/github-pulls?${query}`, {
          headers: { authorization: 'Bearer test-token' },
        })
      );
    const response = await list('involves=&muted=only&q=is%3Aopen');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  });

  test('a typed head: term lifts that branch exclusion', () => {
    const query = buildActiveSearchQuery({
      involves: [],
      mutedBranches: ['renovate', 'dependabot'],
      text: 'is:open head:renovate',
    });
    expect(query).not.toContain('-head:renovate');
    expect(query).toContain('-head:dependabot');
  });

  test('a typed head: under a muted prefix lifts that prefix', () => {
    const query = buildActiveSearchQuery({
      involves: [],
      mutedBranches: ['renovate', 'dependabot'],
      text: 'is:open head:renovate/pkg-update',
    });
    expect(query).not.toContain('-head:renovate');
    expect(query).toContain('-head:dependabot');
  });

  // Age only makes an open pull noise, and a search that already filters or
  // sorts by update time is looking at age on purpose.
  test('staleness applies only to open searches without their own update terms', () => {
    const query = (text: string) =>
      buildActiveSearchQuery({ involves: [], staleCutoff: '2026-09-20', text });
    expect(query('is:open')).toContain('updated:>=2026-09-20');
    expect(query('is:merged')).not.toContain('updated:>=');
    expect(query('is:merged OR is:open')).not.toContain('updated:>=');
    expect(query('NOT is:open')).not.toContain('updated:>=');
    expect(query('is:open OR label:bug')).not.toContain('updated:>=');
    expect(query('is:open -is:merged label:bug')).toContain(
      'updated:>=2026-09-20'
    );
    expect(query('')).not.toContain('updated:>=');
    expect(query('is:open updated:<2026-01-01')).not.toContain(
      'updated:>=2026-09-20'
    );
    expect(query('is:open sort:updated-asc')).not.toContain('updated:>=');
  });

  test('the route reads muteHead and stale', async () => {
    const searches: string[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        variables: { query?: string };
      };
      if (body.variables.query != null) {
        searches.push(body.variables.query);
      }
      return Response.json({
        data: {
          pulls: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          unmuted: { issueCount: 0 },
        },
      });
    }) as typeof fetch);
    try {
      const response = await GET(
        new NextRequest(
          'https://diffshub.test/api/github-pulls?involves=authored&q=is:open&muteHead=renovate&stale=2w',
          { headers: { Authorization: 'Bearer test-token' } }
        )
      );
      expect(response.status).toBe(200);
      expect(searches[0]).toContain('-head:renovate');
      expect(searches[0]).toMatch(/updated:>=\d{4}-\d{2}-\d{2} /);
      const bad = await GET(
        new NextRequest(
          'https://diffshub.test/api/github-pulls?involves=authored&q=is:open&stale=5m',
          { headers: { Authorization: 'Bearer test-token' } }
        )
      );
      expect(bad.status).toBe(400);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
