import { type NextRequest } from 'next/server';

import {
  getGitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
} from '@/lib/githubEnvironment';
import { resolveGitHubViewerId } from '@/lib/githubViewer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';
import { parseJSONBody } from '@/lib/parseJSONBody';
import {
  getPreferenceStore,
  type PreferenceStore,
} from '@/lib/preferenceStore';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import { emitLogLine, formatError } from '@/lib/serverLog';
import {
  isPlainRecord,
  mergePreferenceChanges,
  parseStoredPreferences,
} from '@/lib/userPreferences';

// Per-user key/value preferences, persisted in the deployment's preference
// store (lib/preferenceStore) so they follow a viewer across browsers.
//
//   GET    → { enabled, preferences }
//   PUT    { preferences: { key: value | null } } → merged map; null deletes
//   DELETE → removes every stored preference for the caller
//
// The caller is identified by the numeric GitHub user id behind their bearer
// token (lib/githubViewer). The token itself is never written to the store.
// Concurrent PUTs from two tabs are last-write-wins on the whole map.

interface PreferenceContext {
  // The caller's credentials as presented and as resolved (they differ for
  // sealed envelopes), refused verbatim inside stored values.
  credentials: string[];
  // Includes the instance's normalized web URL (scheme, host, port, path
  // prefix) so deployments sharing one Redis cannot collide on numeric user
  // ids, even for instances on one hostname.
  storageKey: string;
  store: PreferenceStore;
}

// Runs a handler after the shared preamble: the login gate, store
// availability, and caller identity. Store failures become 503s. GET answers
// a disabled store with 200 so the client can stop asking; writes answer it
// with 404.
function withPreferenceContext(
  handler: (
    context: PreferenceContext,
    request: NextRequest
  ) => Promise<Response>,
  options: { read: boolean }
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
      return storeFailure(error);
    }
    if (store == null) {
      return options.read
        ? createJSONResponse({ enabled: false, preferences: {} })
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
      storageKey: `diffshub:preferences:v1:${getGitHubEnvironment().webURL}:${viewerId}`,
      store,
    };
    try {
      return await handler(context, request);
    } catch (error) {
      return storeFailure(error);
    }
  };
}

function storeFailure(error: unknown): Response {
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

async function handleGET({ storageKey, store }: PreferenceContext) {
  return createJSONResponse({
    enabled: true,
    preferences: parseStoredPreferences(await store.get(storageKey)),
  });
}

async function handlePUT(
  { credentials, storageKey, store }: PreferenceContext,
  request: NextRequest
) {
  const changes = (await parseJSONBody(request))?.preferences;
  if (!isPlainRecord(changes)) {
    return createJSONResponse(
      { error: 'Expected a JSON body of the form { "preferences": { ... } }.' },
      { status: 400 }
    );
  }
  const raw = await store.get(storageKey);
  const merged = mergePreferenceChanges(
    parseStoredPreferences(raw),
    changes,
    credentials
  );
  if (merged.error != null) {
    return createJSONResponse({ error: merged.error }, { status: 400 });
  }
  // Skip no-op writes: Workers KV bills each write and allows about one per
  // second per key, and debounced clients often resend unchanged state.
  const next =
    Object.keys(merged.preferences).length === 0 ? null : merged.serialized;
  if (next !== raw) {
    await (next == null
      ? store.delete(storageKey)
      : store.put(storageKey, next));
  }
  return createJSONResponse({
    enabled: true,
    preferences: merged.preferences,
  });
}

async function handleDELETE({ storageKey, store }: PreferenceContext) {
  await store.delete(storageKey);
  return createJSONResponse({ enabled: true, preferences: {} });
}

export const GET = withRequestLog(
  withPreferenceContext(handleGET, { read: true })
);
export const PUT = withRequestLog(
  withPreferenceContext(handlePUT, { read: false })
);
export const DELETE = withRequestLog(
  withPreferenceContext(handleDELETE, { read: false })
);
