import {
  byteLength,
  isForbiddenString,
  isPlainRecord,
} from './userPreferences';

// Shape rules for reviewed-file marks synced through
// /api/preferences/reviewed: one map of file path → content fingerprint
// (lib/reviewedFiles) per diff source. Shared by the browser, which reads
// stored payloads, and the route, which enforces the rules on writes.
//
// Each source gets its own store key with a TTL instead of living in the
// preference map, because marks accumulate with every PR reviewed and a large
// PR's map alone can outgrow the map's per-value cap.

export type ReviewedFilesRecord = Record<string, string>;

export const MAX_REVIEWED_SOURCE_LENGTH = 2048;
const MAX_REVIEWED_FILES = 20_000;
const MAX_REVIEWED_PATH_LENGTH = 4096;
const MAX_REVIEWED_FILES_BYTES = 2 * 1024 * 1024;

// The two fingerprint forms getFileDiffFingerprint produces: a git object id,
// or a base-36 32-bit hash of the hunk structure.
const FINGERPRINT_PATTERN = /^(?:oid:[0-9a-f]{4,64}|h:[0-9a-z]{1,7})$/;

export function isValidReviewedSource(source: unknown): source is string {
  return (
    typeof source === 'string' &&
    source.length > 0 &&
    source.length <= MAX_REVIEWED_SOURCE_LENGTH
  );
}

export type ReviewedFilesParseResult =
  | { error: string; files?: undefined; serialized?: undefined }
  | { error?: undefined; files: ReviewedFilesRecord; serialized: string };

// Validates a reviewed-files map. Entries with a malformed path or
// fingerprint, or a path shaped like a credential (the store must never hold
// one, see lib/userPreferences), are dropped rather than failing the whole
// map, so one odd file name cannot stop a PR's marks from syncing. Only the
// size caps fail outright. Returns the kept map's JSON too, since the route
// stores exactly that.
export function parseReviewedFiles(
  value: unknown,
  forbidden: readonly string[] = []
): ReviewedFilesParseResult {
  if (!isPlainRecord(value)) {
    return { error: 'Reviewed files must be an object of path → fingerprint.' };
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_REVIEWED_FILES) {
    return {
      error: `At most ${MAX_REVIEWED_FILES} reviewed files can be stored per diff.`,
    };
  }
  const files: ReviewedFilesRecord = {};
  for (const [path, fingerprint] of entries) {
    if (
      path.length > 0 &&
      path.length <= MAX_REVIEWED_PATH_LENGTH &&
      typeof fingerprint === 'string' &&
      FINGERPRINT_PATTERN.test(fingerprint) &&
      !isForbiddenString(path, forbidden)
    ) {
      files[path] = fingerprint;
    }
  }
  const serialized = JSON.stringify(files);
  if (byteLength(serialized) > MAX_REVIEWED_FILES_BYTES) {
    return {
      error: `Reviewed files for one diff cannot exceed ${MAX_REVIEWED_FILES_BYTES} bytes.`,
    };
  }
  return { files, serialized };
}

// Parses a stored payload, treating anything unreadable as "nothing stored".
export function parseStoredReviewedFiles(
  raw: string | null
): ReviewedFilesRecord | null {
  if (raw == null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseReviewedFiles(parsed).files ?? null;
}
