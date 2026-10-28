// "Which GitHub user is behind this token": GET /user on the configured
// instance, cached per credential so a burst of requests costs one upstream
// call. Failures come back as ready-to-return route responses and are not
// cached, so a fixed token recovers on the next request.

import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
} from './githubEnvironment';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
  readGitHubJSON,
} from './githubProxyResponse';
import { createJSONResponse } from './jsonResponse';
import { createAsyncLRU, credentialCacheScope } from './serverLRU';

// Short enough that a revoked token stops resolving within minutes, long
// enough that a burst of writes costs one GitHub call.
const viewerIdCache = createAsyncLRU<string, number>({
  maxEntries: 1000,
  ttlMs: 5 * 60_000,
});

// Carries a failure response out of the cache's create callback; rejected
// loads are evicted, so nothing failed is remembered.
class ViewerLookupFailure extends Error {
  constructor(readonly response: Response) {
    super('GitHub viewer lookup failed.');
  }
}

// The numeric GitHub user id for a token, or the response to return instead.
export async function resolveGitHubViewerId(
  token: string
): Promise<number | Response> {
  try {
    return await viewerIdCache.getOrCreate(credentialCacheScope(token), () =>
      fetchViewerId(token)
    );
  } catch (error) {
    if (error instanceof ViewerLookupFailure) {
      // Concurrent callers share one rejection, so each gets its own copy.
      return error.response.clone();
    }
    throw error;
  }
}

async function fetchViewerId(token: string): Promise<number> {
  const environment = getGitHubEnvironment();
  const url = createGitHubAPIURL(environment, '/user');
  let response: Response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      headers: createGitHubJSONHeaders(token),
    });
  } catch {
    throw new ViewerLookupFailure(createUnreachableResponse(environment, url));
  }
  if (!response.ok) {
    throw new ViewerLookupFailure(await createGitHubFailureResponse(response));
  }
  const parsed = await readGitHubJSON(response);
  if (parsed.failure != null) {
    throw new ViewerLookupFailure(parsed.failure);
  }
  const id = (parsed.data as { id?: unknown } | null)?.id;
  if (typeof id !== 'number') {
    throw new ViewerLookupFailure(
      createJSONResponse(
        { error: 'GitHub returned an unexpected user payload.' },
        { status: 502 }
      )
    );
  }
  return id;
}
