import { buildHeaders, requestJSON } from './pullCommentsClient';
import {
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

export function fetchUserPreferences(
  token: string
): Promise<UserPreferencesSnapshot> {
  return send(token, { cache: 'no-store' });
}

// Sets each key to its value, or deletes it when the value is null. Validates
// locally first so an invalid change never leaves the browser.
export function updateUserPreferences(
  token: string,
  changes: Record<string, PreferenceValue>
): Promise<UserPreferencesSnapshot> {
  const local = mergePreferenceChanges({}, changes);
  if (local.error != null) {
    return Promise.reject(new Error(local.error));
  }
  return send(
    token,
    { body: JSON.stringify({ preferences: changes }), method: 'PUT' },
    { 'Content-Type': 'application/json' }
  );
}

export function clearUserPreferences(
  token: string
): Promise<UserPreferencesSnapshot> {
  return send(token, { method: 'DELETE' });
}

async function send(
  token: string,
  init: Omit<RequestInit, 'headers'>,
  headers: Record<string, string> = {}
): Promise<UserPreferencesSnapshot> {
  const payload = (await requestJSON(PREFERENCES_PATH, {
    ...init,
    headers: { ...buildHeaders(token), ...headers },
  })) as { enabled?: unknown; preferences?: unknown } | null;
  return {
    enabled: payload?.enabled === true,
    preferences: isPlainRecord(payload?.preferences)
      ? (payload.preferences as UserPreferences)
      : {},
  };
}
