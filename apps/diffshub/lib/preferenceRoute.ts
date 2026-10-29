import { type NextRequest } from 'next/server';

import {
  getGitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
} from './githubEnvironment';
import { resolveGitHubViewerId } from './githubViewer';
import { createJSONResponse } from './jsonResponse';
import { parseBearerToken } from './parseBearerToken';
import { getPreferenceStore, type PreferenceStore } from './preferenceStore';
import { resolveBearerToken } from './resolveBearerToken';
import { emitLogLine, formatError } from './serverLog';

// Shared request preamble for the per-user routes under /api/preferences
// (the preference map and reviewed-file marks). Both store data per GitHub
// user, identified by the numeric user id behind the bearer token
// (lib/githubViewer); the token itself is never written to the store.

export interface PreferenceContext {
  // The caller's credentials as presented and as resolved (they differ for
  // sealed envelopes), refused verbatim inside stored values.
  credentials: string[];
  store: PreferenceStore;
  // Identifies the caller within the store: the instance's normalized web URL
  // (scheme, host, port, path prefix) and the GitHub user id, so deployments
  // sharing one Redis cannot collide on numeric user ids, even for instances
  // on one hostname. Each route appends it to its own key prefix.
  viewerScope: string;
}

// Runs a handler after the login gate, store availability, and caller
// identity checks. Store failures become 503s. With no store configured, a
// route that passes `disabledRead` answers it with 200 and `enabled: false`
// (reads, so the client can stop asking); others answer 404 (writes).
export function withPreferenceContext(
  handler: (
    context: PreferenceContext,
    request: NextRequest
  ) => Promise<Response>,
  disabledRead?: Record<string, unknown>
) {
  return async (request: NextRequest): Promise<Response> => {
    const rejection = rejectTokenlessRequestWhenLoginRequired(request);
    if (rejection != null) {
      return rejection;
    }
    let store: PreferenceStore | undefined;
    try {
      store = await getPreferenceStore();
    } catch (error) {
      return preferenceStoreFailure(error);
    }
    if (store == null) {
      return disabledRead != null
        ? createJSONResponse({ enabled: false, ...disabledRead })
        : createJSONResponse(
            { error: 'This deployment does not store preferences.' },
            { status: 404 }
          );
    }
    const token = await resolveBearerToken(request);
    if (token == null) {
      return createJSONResponse(
        { error: 'Storing preferences requires signing in.' },
        { status: 401 }
      );
    }
    const viewerId = await resolveGitHubViewerId(token);
    if (viewerId instanceof Response) {
      return viewerId;
    }
    const presented = parseBearerToken(request.headers.get('authorization'));
    const context: PreferenceContext = {
      credentials: [token, presented].filter(
        (value): value is string => value != null && value.length >= 8
      ),
      store,
      viewerScope: `${getGitHubEnvironment().webURL}:${viewerId}`,
    };
    try {
      return await handler(context, request);
    } catch (error) {
      return preferenceStoreFailure(error);
    }
  };
}

function preferenceStoreFailure(error: unknown): Response {
  emitLogLine({
    error: formatError(error),
    event: 'preference_store_error',
    level: 'error',
  });
  return createJSONResponse(
    { error: 'The preference store is unavailable.' },
    { status: 503 }
  );
}
