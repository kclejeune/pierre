import { afterEach, describe, expect, test } from 'bun:test';

import { captureConsole } from './helpers/captureConsole';
import { walkGraphQLConnection } from '@/lib/githubPagination';
import {
  fetchNewReviewThreadState,
  fetchReviewThreadStates,
} from '@/lib/reviewThreadsServer';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface GraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
}

// Replaces the global fetch (which githubFetch resolves per request) with one
// answering each GraphQL request from `respond`, recording what was asked.
function stubGraphQL(
  respond: (request: GraphQLRequest, index: number) => Response
) {
  const requests: GraphQLRequest[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as GraphQLRequest;
    requests.push(request);
    return respond(request, requests.length - 1);
  }) as typeof fetch;
  return requests;
}

function data(payload: unknown): Response {
  return new Response(JSON.stringify({ data: payload }), { status: 200 });
}

// A reviewThreads page holding one thread rooted at `rootId` (resolved when
// the id is even).
function threadsPage(
  rootId: number,
  pageInfo: Record<string, unknown> = { hasNextPage: false }
): Response {
  return data({
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo,
          nodes: [
            {
              id: `PRRT_${rootId}`,
              isResolved: rootId % 2 === 0,
              resolvedBy: null,
              viewerCanResolve: true,
              viewerCanUnresolve: true,
              comments: { nodes: [{ databaseId: rootId }] },
            },
          ],
        },
      },
    },
  });
}

const signal = () => new AbortController().signal;

describe('walkGraphQLConnection', () => {
  const walk = (maxPages: number, onPage: () => boolean | void = () => {}) =>
    walkGraphQLConnection({
      direction: 'forward',
      maxPages,
      onPage,
      query: 'query',
      readConnection: (payload) => (payload as { page: unknown }).page,
      token: 'tok',
      variables: { id: 'x' },
    });
  const page = (endCursor: string | null) =>
    data({ page: { pageInfo: { hasNextPage: endCursor != null, endCursor } } });

  test('chains cursors until the last page', async () => {
    const requests = stubGraphQL((_request, index) =>
      page(index < 2 ? `c${index}` : null)
    );
    expect(await walk(10)).toEqual({ exhausted: true });
    expect(requests.map((request) => request.variables.after)).toEqual([
      null,
      'c0',
      'c1',
    ]);
    expect(requests[1]?.variables.id).toBe('x');
  });

  test('stops short of the end at maxPages or when onPage declines', async () => {
    let requests = stubGraphQL((_request, index) => page(`c${index}`));
    expect(await walk(2)).toEqual({ exhausted: false });
    expect(requests).toHaveLength(2);

    requests = stubGraphQL((_request, index) => page(`c${index}`));
    expect(await walk(5, () => false)).toEqual({ exhausted: false });
    expect(requests).toHaveLength(1);
  });
});

describe('fetchReviewThreadStates', () => {
  test('keys every page by root comment id', async () => {
    stubGraphQL((_request, index) =>
      index === 0
        ? threadsPage(1, { hasNextPage: true, endCursor: 'c1' })
        : threadsPage(2)
    );
    const states = await fetchReviewThreadStates(
      'acme',
      'widgets',
      7,
      'tok',
      signal()
    );
    expect(Object.keys(states)).toEqual(['1', '2']);
    expect(states[2]?.isResolved).toBe(true);
  });

  test('keeps the pages read before a later page fails', async () => {
    stubGraphQL((_request, index) =>
      index === 0
        ? threadsPage(1, { hasNextPage: true, endCursor: 'c1' })
        : new Response('bad gateway', { status: 502 })
    );
    let states: Record<number, unknown> = {};
    await captureConsole(async () => {
      states = await fetchReviewThreadStates(
        'acme',
        'widgets',
        7,
        'tok',
        signal()
      );
    });
    expect(Object.keys(states)).toEqual(['1']);
  });

  test('throws when the first page fails', async () => {
    stubGraphQL(() => new Response('bad gateway', { status: 502 }));
    let failed = false;
    await captureConsole(() =>
      fetchReviewThreadStates('acme', 'widgets', 7, 'tok', signal()).catch(
        () => {
          failed = true;
        }
      )
    );
    expect(failed).toBe(true);
  });

  test('reads nothing once the request is aborted', async () => {
    const requests = stubGraphQL(() => threadsPage(1));
    const controller = new AbortController();
    controller.abort();
    expect(
      await fetchReviewThreadStates(
        'acme',
        'widgets',
        7,
        'tok',
        controller.signal
      )
    ).toEqual({});
    expect(requests).toHaveLength(0);
  });
});

describe('fetchNewReviewThreadState', () => {
  test('finds the thread among the newest, or returns null', async () => {
    stubGraphQL(() => threadsPage(4));
    expect(
      (
        await fetchNewReviewThreadState(
          'acme',
          'widgets',
          7,
          4,
          'tok',
          signal()
        )
      )?.nodeId
    ).toBe('PRRT_4');
    expect(
      await fetchNewReviewThreadState('acme', 'widgets', 7, 5, 'tok', signal())
    ).toBeNull();
  });
});
