import { walkGraphQLConnection } from './githubPagination';
import {
  readReviewThreadNode,
  REVIEW_THREAD_STATE_FIELDS,
} from './reviewThreadState';
import type { PullReviewThreadState } from './types';
import { asRecord } from './untypedJson';

// Server-side reads of pull request review threads' resolution status, which
// only GitHub's GraphQL API exposes. States are keyed by the REST id of each
// thread's first comment, which is how the REST-built threads identify
// themselves (`rootId`).

// Pages read before giving up, matching the REST comment reads' cap.
const MAX_THREAD_PAGES = 10;

// `window` selects the connection slice: `first: 100, after: $after` to walk
// every thread, or `last: N, before: $before` for the newest ones.
function reviewThreadsQuery(window: string, variables: string): string {
  return `query ($owner: String!, $repo: String!, $number: Int!${variables}) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(${window}) {
          pageInfo { hasNextPage endCursor hasPreviousPage startCursor }
          nodes {
            ${REVIEW_THREAD_STATE_FIELDS}
            comments(first: 1) { nodes { databaseId } }
          }
        }
      }
    }
  }`;
}

const ALL_THREADS_QUERY = reviewThreadsQuery(
  'first: 100, after: $after',
  ', $after: String'
);
// A just-created thread is the pull request's newest, so a short tail of the
// connection finds it without paging; the slack covers threads others
// opened in the meantime.
const NEWEST_THREADS_QUERY = reviewThreadsQuery(
  'last: 20, before: $before',
  ', $before: String'
);

// The reviewThreads connection in a response's `data`.
function readThreadsConnection(data: unknown): unknown {
  return asRecord(asRecord(asRecord(data)?.repository)?.pullRequest)
    ?.reviewThreads;
}

// A reviewThreads page's nodes as [root comment id, state] pairs, skipping
// malformed ones.
function readThreadStates(
  connection: unknown
): Array<[number, PullReviewThreadState]> {
  const nodes = asRecord(connection)?.nodes;
  const states: Array<[number, PullReviewThreadState]> = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const state = readReviewThreadNode(node);
    const comments = asRecord(asRecord(node)?.comments)?.nodes;
    const rootId = Array.isArray(comments)
      ? asRecord(comments[0])?.databaseId
      : undefined;
    if (state != null && typeof rootId === 'number') {
      states.push([rootId, state]);
    }
  }
  return states;
}

// Every review thread's resolution status by root comment id, capped at
// MAX_THREAD_PAGES pages and stopping once `signal` aborts. A page that
// fails after earlier ones succeeded ends the walk with what was read
// (those threads keep their controls); a first-page failure throws.
export async function fetchReviewThreadStates(
  owner: string,
  repo: string,
  number: number,
  token: string,
  signal: AbortSignal
): Promise<Record<number, PullReviewThreadState>> {
  const states: Record<number, PullReviewThreadState> = {};
  let pagesRead = 0;
  try {
    await walkGraphQLConnection({
      direction: 'forward',
      maxPages: MAX_THREAD_PAGES,
      onPage: (connection) => {
        pagesRead++;
        for (const [rootId, state] of readThreadStates(connection)) {
          states[rootId] = state;
        }
      },
      query: ALL_THREADS_QUERY,
      readConnection: readThreadsConnection,
      signal,
      token,
      variables: { number, owner, repo },
    });
  } catch (error) {
    if (pagesRead === 0) {
      throw error;
    }
  }
  return states;
}

// The resolution status of the thread rooted at `rootId`, looked up among
// the pull request's newest threads; null when it isn't among them.
export async function fetchNewReviewThreadState(
  owner: string,
  repo: string,
  number: number,
  rootId: number,
  token: string,
  signal: AbortSignal
): Promise<PullReviewThreadState | null> {
  let found: PullReviewThreadState | null = null;
  await walkGraphQLConnection({
    direction: 'backward',
    maxPages: 1,
    onPage: (connection) => {
      found =
        readThreadStates(connection).find(([id]) => id === rootId)?.[1] ?? null;
    },
    query: NEWEST_THREADS_QUERY,
    readConnection: readThreadsConnection,
    signal,
    token,
    variables: { number, owner, repo },
  });
  return found;
}
