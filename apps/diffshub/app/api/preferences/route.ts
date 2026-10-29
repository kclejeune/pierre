import { type NextRequest } from 'next/server';

import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import {
  type PreferenceContext,
  withPreferenceContext,
} from '@/lib/preferenceRoute';
import { withRequestLog } from '@/lib/requestLog';
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
// token (lib/preferenceRoute). The token itself is never written to the store.
// Concurrent PUTs from two tabs are last-write-wins on the whole map.
// Reviewed-file marks live beside it in ./reviewed, one key per diff source.

// The whole preference map for a caller lives under one key.
function storageKey({ viewerScope }: PreferenceContext): string {
  return `diffshub:preferences:v1:${viewerScope}`;
}

async function handleGET(context: PreferenceContext) {
  return createJSONResponse({
    enabled: true,
    preferences: parseStoredPreferences(
      await context.store.get(storageKey(context))
    ),
  });
}

async function handlePUT(context: PreferenceContext, request: NextRequest) {
  const { credentials, store } = context;
  const key = storageKey(context);
  const changes = (await parseJSONBody(request))?.preferences;
  if (!isPlainRecord(changes)) {
    return createJSONResponse(
      { error: 'Expected a JSON body of the form { "preferences": { ... } }.' },
      { status: 400 }
    );
  }
  const raw = await store.get(key);
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
    await (next == null ? store.delete(key) : store.put(key, next));
  }
  return createJSONResponse({
    enabled: true,
    preferences: merged.preferences,
  });
}

async function handleDELETE(context: PreferenceContext) {
  await context.store.delete(storageKey(context));
  return createJSONResponse({ enabled: true, preferences: {} });
}

export const GET = withRequestLog(
  withPreferenceContext(handleGET, { preferences: {} })
);
export const PUT = withRequestLog(withPreferenceContext(handlePUT));
export const DELETE = withRequestLog(withPreferenceContext(handleDELETE));
