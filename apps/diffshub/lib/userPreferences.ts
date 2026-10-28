// Shape and safety rules for server-synced user preferences: a flat map of
// short keys to small JSON values, stored per GitHub user by
// /api/preferences. Shared by the browser client (to fail early) and the
// route (which enforces them).
//
// Preferences are display state like theme picks and pinned repositories.
// They must never hold credentials: the store outlives every token and is
// readable by anyone who later signs in as the same GitHub user. Any value
// (or nested object key) containing a string shaped like a GitHub token, a
// DiffsHub sealed or wrapped token, a JWT, or a bearer header is refused, and
// so is a top-level key that is itself such a string. What a key is called
// does not matter: `authorFilter` or `oauthHint` are ordinary preferences. The route also passes the caller's own credential as a forbidden
// substring, whatever its shape.

import {
  SEALED_TOKEN_PREFIX,
  WRAPPED_REFRESH_TOKEN_PREFIX,
} from './tokenEnvelope';

export type PreferenceValue =
  | boolean
  | number
  | string
  | null
  | PreferenceValue[]
  | { [key: string]: PreferenceValue };

export type UserPreferences = Record<string, PreferenceValue>;

export const MAX_PREFERENCE_KEYS = 100;
const MAX_PREFERENCE_VALUE_BYTES = 8 * 1024;
const MAX_PREFERENCES_TOTAL_BYTES = 64 * 1024;
const MAX_VALUE_DEPTH = 8;

const KEY_PATTERN = /^[A-Za-z0-9][\w.-]{0,63}$/;

// Strings that look like credentials, matched anywhere in a string: no word
// boundary is required, so a prefix like `backup_ghp_...` cannot hide one.
// GitHub token prefixes per
// https://github.blog/2021-04-05-behind-githubs-new-authentication-token-formats/
const CREDENTIAL_PATTERNS: RegExp[] = [
  // ghp_ (classic PAT), gho_ (OAuth), ghu_ (App user), ghs_ (App
  // installation), ghr_ (refresh).
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  // Fine-grained PATs.
  /github_pat_[A-Za-z0-9_]{20,}/,
  // Sealed envelopes from lib/tokenSeal: dhe1.<kind>.<nonce>.<ciphertext>.
  new RegExp(`${SEALED_TOKEN_PREFIX}\\.[\\w-]+\\.[\\w-]+\\.[\\w-]+`),
  // Wrapped refresh tokens from lib/refreshTokenWrap: dhr1.<payload>.<mac>.
  new RegExp(`${WRAPPED_REFRESH_TOKEN_PREFIX}\\.[\\w-]+\\.[\\w-]+`),
  // JWTs: base64url JSON header and payload, then a signature.
  /eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*/,
  /bearer\s+\S{16,}/i,
];

export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

// Why a key cannot be stored, or null when it is acceptable. Keys get the same
// credential-shape screen as values, since a token fits the key pattern.
export function describeInvalidPreferenceKey(
  key: string,
  forbidden: readonly string[] = []
): string | null {
  if (!KEY_PATTERN.test(key)) {
    return `Preference key "${key.slice(0, 64)}" must be 1-64 letters, digits, '.', '_' or '-'.`;
  }
  if (isForbiddenString(key, forbidden)) {
    return 'A preference key contains a credential-shaped string; credentials cannot be stored as preferences.';
  }
  return null;
}

// Why a value cannot be stored, or null when it is acceptable. One walk checks
// the JSON shape and every string (including object keys), so a credential
// cannot hide in nesting. `forbidden` lists exact strings to refuse anywhere,
// which the route uses for the caller's own credential.
function describeInvalidPreferenceValue(
  key: string,
  value: unknown,
  forbidden: readonly string[] = []
): string | null {
  const problem = findValueProblem(value, 0, forbidden);
  if (problem === 'shape') {
    return `Preference "${key}" must be a JSON value nested at most ${MAX_VALUE_DEPTH} levels deep.`;
  }
  if (problem === 'credential') {
    return `Preference "${key}" contains a credential-shaped string; credentials cannot be stored as preferences.`;
  }
  if (byteLength(JSON.stringify(value)) > MAX_PREFERENCE_VALUE_BYTES) {
    return `Preference "${key}" exceeds ${MAX_PREFERENCE_VALUE_BYTES} bytes.`;
  }
  return null;
}

function findValueProblem(
  value: unknown,
  depth: number,
  forbidden: readonly string[]
): 'credential' | 'shape' | null {
  if (depth > MAX_VALUE_DEPTH) {
    return 'shape';
  }
  if (value === null || typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : 'shape';
  }
  if (typeof value === 'string') {
    return isForbiddenString(value, forbidden) ? 'credential' : null;
  }
  if (typeof value !== 'object') {
    return 'shape';
  }
  const entries: [string | null, unknown][] = Array.isArray(value)
    ? value.map((entry) => [null, entry])
    : Object.entries(value);
  for (const [entryKey, entry] of entries) {
    if (entryKey != null && isForbiddenString(entryKey, forbidden)) {
      return 'credential';
    }
    const problem = findValueProblem(entry, depth + 1, forbidden);
    if (problem != null) {
      return problem;
    }
  }
  return null;
}

function isForbiddenString(
  value: string,
  forbidden: readonly string[]
): boolean {
  return (
    looksLikeCredential(value) ||
    forbidden.some((needle) => value.includes(needle))
  );
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

// A JSON object that is not an array: the shape of a preference map.
export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

// Parses a stored preference blob, dropping anything that no longer passes
// validation (e.g. after a rule tightened) rather than failing the read.
export function parseStoredPreferences(raw: string | null): UserPreferences {
  if (raw == null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainRecord(parsed)) {
    return {};
  }
  const preferences: UserPreferences = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      describeInvalidPreferenceKey(key) == null &&
      describeInvalidPreferenceValue(key, value) == null
    ) {
      preferences[key] = value as PreferenceValue;
    }
  }
  return preferences;
}

export type PreferenceMergeResult =
  | { error: string; preferences?: undefined; serialized?: undefined }
  | { error?: undefined; preferences: UserPreferences; serialized: string };

// Applies a partial update to the stored map: a null value deletes its key,
// anything else is validated and set. Fails as a whole when any entry is
// invalid or the merged result exceeds the key-count or size caps. Returns the
// merged map's JSON too, since the caller writes exactly that.
export function mergePreferenceChanges(
  current: UserPreferences,
  changes: Record<string, unknown>,
  forbidden: readonly string[] = []
): PreferenceMergeResult {
  const next: UserPreferences = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    const error =
      describeInvalidPreferenceKey(key, forbidden) ??
      (value === null
        ? null
        : describeInvalidPreferenceValue(key, value, forbidden));
    if (error != null) {
      return { error };
    }
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value as PreferenceValue;
    }
  }
  if (Object.keys(next).length > MAX_PREFERENCE_KEYS) {
    return {
      error: `At most ${MAX_PREFERENCE_KEYS} preferences can be stored.`,
    };
  }
  const serialized = JSON.stringify(next);
  if (byteLength(serialized) > MAX_PREFERENCES_TOTAL_BYTES) {
    return {
      error: `Stored preferences cannot exceed ${MAX_PREFERENCES_TOTAL_BYTES} bytes in total.`,
    };
  }
  return { preferences: next, serialized };
}
