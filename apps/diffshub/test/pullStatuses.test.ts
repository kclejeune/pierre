import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET as listPulls } from '../app/api/github-pulls/route';
import { GET as readStatuses } from '../app/api/pull-statuses/route';
import {
  buildActivePullsRequests,
  isValidNodeId,
  mergeActivePullsResponses,
  parsePullStatusesPayload,
  type PullSummary,
} from '@/lib/githubPullSummaries';
import {
  applyPullStatuses,
  clearPullStatuses,
  markPullStatusesInFlight,
  PULL_STATUS_TTL_MS,
  pullsNeedingStatus,
  storePullStatuses,
} from '@/lib/pullStatusCache';
import { clearPullStatusCache } from '@/lib/pullStatusesServer';

afterEach(() => {
  clearPullStatuses();
  clearPullStatusCache();
});

describe('buildActivePullsRequests', () => {
  test('sends the commented and unmuted searches only when they apply', () => {
    const everything = buildActivePullsRequests({
      involves: [],
      mutedAuthors: ['app/renovate'],
      text: 'is:open',
    });
    expect(everything.map((search) => search.alias)).toEqual([
      'pulls',
      'commented',
      'unmuted',
    ]);
    // Each search carries only the variables its query declares.
    expect(Object.keys(everything[0].variables).sort()).toEqual([
      'after',
      'first',
      'query',
    ]);
    expect(Object.keys(everything[1].variables).sort()).toEqual([
      'commentedFirst',
      'commentedQuery',
    ]);
    expect(Object.keys(everything[2].variables)).toEqual(['unmutedQuery']);

    const authoredOnly = buildActivePullsRequests({ involves: ['authored'] });
    expect(authoredOnly.map((search) => search.alias)).toEqual(['pulls']);
  });

  test('the list search no longer reads CI or review state', () => {
    const [main] = buildActivePullsRequests({ involves: [] });
    expect(main.query).not.toContain('statusCheckRollup');
    expect(main.query).not.toContain('reviewDecision');
  });

  test('merging takes each response only under its own alias', () => {
    expect(
      mergeActivePullsResponses([
        { alias: 'pulls', data: { pulls: { issueCount: 1 }, stray: 1 } },
        { alias: 'commented', data: { commented: { nodes: [] } } },
        { alias: 'unmuted', data: { pulls: 'ignored' } },
      ])
    ).toEqual({ commented: { nodes: [] }, pulls: { issueCount: 1 } });
  });
});

describe('parsePullStatusesPayload', () => {
  test('maps rollup and review decision by node id, skipping null nodes', () => {
    expect(
      parsePullStatusesPayload({
        nodes: [
          {
            id: 'PR_a',
            reviewDecision: 'APPROVED',
            commits: {
              nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }],
            },
          },
          null,
          { id: 'PR_b', reviewDecision: null, commits: { nodes: [] } },
        ],
      })
    ).toEqual({
      PR_a: { checks: 'failure', reviewDecision: 'approved' },
      PR_b: {},
    });
  });

  test('accepts both node id formats', () => {
    expect(isValidNodeId('PR_kwDOAbc123')).toBe(true);
    expect(isValidNodeId('MDExOlB1bGxSZXF1ZXN0MQ==')).toBe(true);
    expect(isValidNodeId('PR_1 OR x')).toBe(false);
    expect(isValidNodeId('')).toBe(false);
  });
});

describe('GET /api/pull-statuses', () => {
  const read = (query: string, headers?: HeadersInit) =>
    readStatuses(
      new NextRequest(`https://diffshub.test/api/pull-statuses?${query}`, {
        headers,
      })
    );

  test('validates ids before the token check', async () => {
    expect((await read('')).status).toBe(400);
    expect((await read('ids=PR_a%20b')).status).toBe(400);
    const tooMany = Array.from({ length: 26 }, (_, index) => `PR_${index}`);
    expect((await read(`ids=${tooMany.join(',')}`)).status).toBe(400);
    expect((await read('ids=PR_a,PR_b')).status).toBe(401);
  });

  test('reads the ids in parallel chunks and merges the statuses', async () => {
    const chunks: string[][] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(init?.body as string) as {
        variables: { ids: string[] };
      };
      chunks.push(body.variables.ids);
      return Promise.resolve(
        Response.json({
          data: {
            nodes: body.variables.ids.map((id) => ({
              id,
              reviewDecision: 'REVIEW_REQUIRED',
              commits: { nodes: [] },
            })),
          },
        })
      );
    }) as typeof fetch);
    try {
      const ids = Array.from({ length: 8 }, (_, index) => `PR_${index}`);
      const response = await read(`ids=${ids.join(',')}`, {
        Authorization: 'Bearer ghu_token',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        statuses: Record<string, unknown>;
      };
      expect(Object.keys(body.statuses).sort()).toEqual(ids.sort());
      expect(chunks.map((chunk) => chunk.length)).toEqual([6, 2]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('GET /api/github-pulls', () => {
  test("sends the page's searches concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const { query } = JSON.parse(init?.body as string) as { query: string };
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const data = query.includes('commented: search')
        ? { commented: { nodes: [] } }
        : {
            pulls: {
              issueCount: 0,
              pageInfo: { endCursor: null, hasNextPage: false },
              nodes: [],
            },
          };
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight -= 1;
          resolve(Response.json({ data }));
        }, 5)
      );
    }) as typeof fetch);
    try {
      const response = await listPulls(
        new NextRequest('https://diffshub.test/api/github-pulls?q=is%3Aopen', {
          headers: { Authorization: 'Bearer ghu_token' },
        })
      );
      expect(response.status).toBe(200);
      expect(maxInFlight).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('GET /api/pull-statuses server cache', () => {
  test('reuses statuses per updatedAt and re-reads changed pulls', async () => {
    const reads: string[][] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(init?.body as string) as {
        variables: { ids: string[] };
      };
      reads.push(body.variables.ids);
      return Promise.resolve(
        Response.json({
          data: {
            nodes: body.variables.ids.map((id) =>
              id === 'PR_hidden'
                ? null
                : { id, reviewDecision: 'APPROVED', commits: { nodes: [] } }
            ),
          },
        })
      );
    }) as typeof fetch);
    const read = (ids: string, versions: string) =>
      readStatuses(
        new NextRequest(
          `https://diffshub.test/api/pull-statuses?ids=${ids}&v=${encodeURIComponent(versions)}`,
          { headers: { Authorization: 'Bearer ghu_token' } }
        )
      );
    const t1 = '2026-08-02T09:00:00Z';
    const t2 = '2026-08-02T10:00:00Z';
    try {
      expect((await read('PR_a,PR_hidden', `${t1},${t1}`)).status).toBe(200);
      expect(reads).toEqual([['PR_a', 'PR_hidden']]);
      // Same versions: both answer from the cache, including the
      // unreadable one, which stays missing.
      const cached = (await (
        await read('PR_a,PR_hidden', `${t1},${t1}`)
      ).json()) as { statuses: Record<string, unknown> };
      expect(reads).toHaveLength(1);
      expect(Object.keys(cached.statuses)).toEqual(['PR_a']);
      // A new updatedAt (a review, a push) misses and re-reads that pull.
      expect((await read('PR_a,PR_hidden', `${t2},${t1}`)).status).toBe(200);
      expect(reads[1]).toEqual(['PR_a']);
      // Versions must line up with the ids.
      expect((await read('PR_a,PR_b', t1)).status).toBe(400);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('a request for pulls already being read joins that read', async () => {
    const reads: string[][] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(init?.body as string) as {
        variables: { ids: string[] };
      };
      reads.push(body.variables.ids);
      await gate;
      return Response.json({
        data: {
          nodes: body.variables.ids.map((id) => ({
            id,
            reviewDecision: 'APPROVED',
            commits: { nodes: [] },
          })),
        },
      });
    }) as typeof fetch);
    const read = (ids: string, versions: string) =>
      readStatuses(
        new NextRequest(
          `https://diffshub.test/api/pull-statuses?ids=${ids}&v=${encodeURIComponent(versions)}`,
          { headers: { Authorization: 'Bearer ghu_token' } }
        )
      );
    const t1 = '2026-08-02T09:00:00Z';
    try {
      const first = read('PR_a', t1);
      // Let the first read reach GitHub before the second arrives.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = read('PR_a,PR_b', `${t1},${t1}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      const [firstBody, secondBody] = (await Promise.all(
        [first, second].map(async (response) => (await response).json())
      )) as { statuses: Record<string, unknown> }[];
      // PR_a went to GitHub once; the second request read only PR_b.
      expect(reads).toEqual([['PR_a'], ['PR_b']]);
      expect(Object.keys(firstBody?.statuses ?? {})).toEqual(['PR_a']);
      expect(Object.keys(secondBody?.statuses ?? {}).sort()).toEqual([
        'PR_a',
        'PR_b',
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('pullStatusCache', () => {
  const pull = (overrides: Partial<PullSummary> = {}): PullSummary => ({
    number: 7,
    owner: 'acme',
    repo: 'widgets',
    title: 'Tune the warp core',
    state: 'open',
    updatedAt: '2026-08-02T09:00:00Z',
    viewerPath: '/acme/widgets/pull/7',
    nodeId: 'PR_7',
    ...overrides,
  });

  test('a read in flight is not sent again until it lands', () => {
    const rows = [pull()];
    markPullStatusesInFlight(rows, 1);
    expect(pullsNeedingStatus(rows, 1, 0)).toEqual([]);
    // Still pending for display, though.
    expect(applyPullStatuses(rows, 1).pending.size).toBe(1);
    storePullStatuses(rows, 1, {}, 0);
    expect(applyPullStatuses(rows, 1).pending.size).toBe(0);
  });

  test('rows wait for a status, then show it', () => {
    const rows = [pull()];
    expect(pullsNeedingStatus(rows, 1, 0)).toEqual(rows);
    expect([...applyPullStatuses(rows, 1).pending]).toEqual(['acme/widgets#7']);
    storePullStatuses(rows, 1, { PR_7: { checks: 'success' } }, 0);
    const applied = applyPullStatuses(rows, 1);
    expect(applied.pending.size).toBe(0);
    expect(applied.pulls[0].checks).toBe('success');
    expect(pullsNeedingStatus(rows, 1, 0)).toEqual([]);
  });

  test('a status goes stale after the TTL but still shows meanwhile', () => {
    const rows = [pull()];
    storePullStatuses(rows, 1, { PR_7: { reviewDecision: 'approved' } }, 0);
    expect(pullsNeedingStatus(rows, 1, PULL_STATUS_TTL_MS)).toEqual(rows);
    expect(applyPullStatuses(rows, 1).pulls[0].reviewDecision).toBe('approved');
  });

  test('a changed pull or a new token reads afresh', () => {
    storePullStatuses([pull()], 1, { PR_7: { checks: 'success' } }, 0);
    const edited = [pull({ updatedAt: '2026-08-03T09:00:00Z' })];
    expect(pullsNeedingStatus(edited, 1, 0)).toEqual(edited);
    expect(pullsNeedingStatus([pull()], 2, 0)).toHaveLength(1);
  });

  test('an unreadable or failed status stops the row waiting', () => {
    const rows = [pull()];
    storePullStatuses(rows, 1, {}, 0);
    const applied = applyPullStatuses(rows, 1);
    expect(applied.pending.size).toBe(0);
    expect(applied.pulls[0].checks).toBeUndefined();
  });

  test('rows without a node id keep the status they came with', () => {
    const legacy = pull({ checks: 'failure', nodeId: undefined });
    expect(pullsNeedingStatus([legacy], 1, 0)).toEqual([]);
    const applied = applyPullStatuses([legacy], 1);
    expect(applied.pending.size).toBe(0);
    expect(applied.pulls[0]).toBe(legacy);
  });
});
