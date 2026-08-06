import type { FileDiffMetadata } from '@pierre/diffs';

// Persistence for per-file "Viewed" marks, GitHub-style: each diff source
// (PR, commit, patch URL) stores a map of file path → content fingerprint in
// localStorage. A mark only holds while the file's fingerprint still matches,
// so new commits touching a reviewed file clear its mark automatically.

const STORAGE_PREFIX = 'diffshub.reviewed.';

// Fingerprint of the file's post-change content. Prefers the git object id
// from the patch's `index` line — which changes exactly when the file's new
// content changes — and falls back to hashing the hunk structure for patches
// without index metadata.
export function getFileDiffFingerprint(fileDiff: FileDiffMetadata): string {
  const objectId = fileDiff.newObjectId;
  if (objectId != null && objectId !== '') {
    return `oid:${objectId}`;
  }
  let hash = 5381;
  const feed = (text: string) => {
    for (let index = 0; index < text.length; index++) {
      hash = (Math.imul(hash, 33) ^ text.charCodeAt(index)) >>> 0;
    }
  };
  feed(fileDiff.type);
  feed(fileDiff.name);
  for (const hunk of fileDiff.hunks) {
    feed(
      `@${hunk.deletionStart},${hunk.deletionCount},${hunk.deletionLines}+${hunk.additionStart},${hunk.additionCount},${hunk.additionLines}`
    );
  }
  return `h:${hash.toString(36)}`;
}

export function loadReviewedFiles(sourceKey: string): Map<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + sourceKey);
    if (raw == null) {
      return new Map();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed == null) {
      return new Map();
    }
    const map = new Map<string, string>();
    for (const [path, fingerprint] of Object.entries(parsed)) {
      if (typeof fingerprint === 'string') {
        map.set(path, fingerprint);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function saveReviewedFiles(
  sourceKey: string,
  reviewed: ReadonlyMap<string, string>
): void {
  try {
    const key = STORAGE_PREFIX + sourceKey;
    if (reviewed.size === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(
        key,
        JSON.stringify(Object.fromEntries(reviewed))
      );
    }
  } catch {
    // Storage unavailable; marks still hold for this session.
  }
}
