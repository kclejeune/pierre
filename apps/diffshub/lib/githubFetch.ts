import { createLimitedFetch } from './concurrencyLimit';
import { type PlainFetch } from './plainFetch';
import { credentialCacheScope } from './serverLRU';

// The fetch every server-side GitHub call goes through. It bounds how many
// requests one credential has in flight across the whole process (or Workers
// isolate), so concurrent API requests and browser tabs from the same viewer
// share one budget under GHE's secondary rate limit. Each distinct
// Authorization value gets its own FIFO queue; anonymous requests share one.
// Queues are keyed by a digest of the header (credentialCacheScope), so the
// raw credential never becomes a map key, and a queue is dropped as soon as
// it goes idle.
//
// Calls resolve `globalThis.fetch` at request time, so tests that stub the
// global fetch keep working through this wrapper.

// Concurrent GitHub requests one credential may have in flight. GHE's
// secondary rate limit rejected bursts of several hundred concurrent
// requests; 16 held across a 3,500-request tree walk without rejections.
const GITHUB_REQUEST_CONCURRENCY = 16;

interface CredentialQueue {
  fetch: PlainFetch;
  pending: number;
}

const queues = new Map<string, CredentialQueue>();

const globalFetch: PlainFetch = (input, init) => globalThis.fetch(input, init);

export const githubFetch: PlainFetch = async (input, init) => {
  const key = credentialCacheScope(readAuthorization(input, init));
  let queue = queues.get(key);
  if (queue == null) {
    queue = {
      fetch: createLimitedFetch(GITHUB_REQUEST_CONCURRENCY, globalFetch),
      pending: 0,
    };
    queues.set(key, queue);
  }
  queue.pending += 1;
  try {
    return await queue.fetch(input, init);
  } finally {
    queue.pending -= 1;
    if (queue.pending === 0) {
      queues.delete(key);
    }
  }
};

function readAuthorization(
  input: Parameters<PlainFetch>[0],
  init: Parameters<PlainFetch>[1]
): string {
  const headers =
    init?.headers ?? (input instanceof Request ? input.headers : undefined);
  return new Headers(headers).get('authorization') ?? '';
}

// For tests: how many credentials currently have queued or in-flight requests.
export function countActiveGitHubCredentialQueues(): number {
  return queues.size;
}
