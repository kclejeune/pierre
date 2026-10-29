import { buildHeaders, requestJSON } from './pullCommentsClient';
import {
  parseReviewedFiles,
  type ReviewedFilesRecord,
} from './reviewedFilesPayload';
import {
  byteLength,
  isPlainRecord,
  mergePreferenceChanges,
  type PreferenceValue,
  type UserPreferences,
} from './userPreferences';

// Browser client for /api/preferences. `enabled: false` means the deployment
// has no preference store configured; callers should keep using localStorage
// and stop calling.
//
// Workers KV allows about one write per second per key and every preference
// for a user shares one key, so callers should debounce bursts of changes
// into one updateUserPreferences call.

export interface UserPreferencesSnapshot {
  enabled: boolean;
  preferences: UserPreferences;
}

const PREFERENCES_PATH = '/api/preferences';

export async function fetchUserPreferences(
  token: string
): Promise<UserPreferencesSnapshot> {
  return readPreferencesSnapshot(
    await send(PREFERENCES_PATH, token, { cache: 'no-store' })
  );
}

// Sets each key to its value, or deletes it when the value is null. Validates
// locally first so an invalid change never leaves the browser. `keepalive`
// lets a write started while the page unloads finish after it.
export async function updateUserPreferences(
  token: string,
  changes: Record<string, PreferenceValue>,
  { keepalive = false }: { keepalive?: boolean } = {}
): Promise<UserPreferencesSnapshot> {
  const local = mergePreferenceChanges({}, changes);
  if (local.error != null) {
    throw new Error(local.error);
  }
  return readPreferencesSnapshot(
    await send(PREFERENCES_PATH, token, {
      body: { preferences: changes },
      keepalive,
      method: 'PUT',
    })
  );
}

export async function clearUserPreferences(
  token: string
): Promise<UserPreferencesSnapshot> {
  return readPreferencesSnapshot(
    await send(PREFERENCES_PATH, token, { method: 'DELETE' })
  );
}

export interface ReviewedFilesSnapshot {
  enabled: boolean;
  // Null when nothing is stored for the source yet.
  files: ReviewedFilesRecord | null;
}

const REVIEWED_PATH = '/api/preferences/reviewed';

export async function fetchReviewedFiles(
  token: string,
  source: string,
  signal?: AbortSignal
): Promise<ReviewedFilesSnapshot> {
  const payload = (await send(
    `${REVIEWED_PATH}?${new URLSearchParams({ source })}`,
    token,
    { cache: 'no-store', signal }
  )) as { enabled?: unknown; files?: unknown } | null;
  return {
    enabled: payload?.enabled === true,
    files:
      payload?.files == null
        ? null
        : (parseReviewedFiles(payload.files).files ?? null),
  };
}

// Replaces the stored marks for one diff source.
export async function updateReviewedFiles(
  token: string,
  source: string,
  files: ReviewedFilesRecord,
  { keepalive = false }: { keepalive?: boolean } = {}
): Promise<void> {
  await send(REVIEWED_PATH, token, {
    body: { files, source },
    keepalive,
    method: 'PUT',
  });
}

// Browsers refuse a keepalive request once the bodies of all in-flight
// keepalive requests would pass 64 KiB. Staying under it leaves room for the
// other synced store's flush (the preference map is normally tiny).
const KEEPALIVE_BODY_LIMIT_BYTES = 60 * 1024;

// One authenticated request to a preferences route; a `body` is sent as JSON.
// A body too large for keepalive goes as an ordinary request, which still
// completes when the page is only hidden, rather than failing outright.
function send(
  path: string,
  token: string,
  {
    body,
    keepalive = false,
    ...init
  }: Omit<RequestInit, 'body' | 'headers'> & { body?: object }
): Promise<unknown> {
  if (body == null) {
    return requestJSON(path, { ...init, headers: buildHeaders(token) });
  }
  const serialized = JSON.stringify(body);
  return requestJSON(path, {
    ...init,
    body: serialized,
    headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
    keepalive:
      keepalive && byteLength(serialized) <= KEEPALIVE_BODY_LIMIT_BYTES,
  });
}

function readPreferencesSnapshot(payload: unknown): UserPreferencesSnapshot {
  const record = payload as { enabled?: unknown; preferences?: unknown } | null;
  return {
    enabled: record?.enabled === true,
    preferences: isPlainRecord(record?.preferences)
      ? (record.preferences as UserPreferences)
      : {},
  };
}
