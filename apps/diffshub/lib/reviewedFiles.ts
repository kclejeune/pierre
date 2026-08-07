import type { FileDiffMetadata } from '@pierre/diffs';

import { readStoredJSON, writeStoredJSON } from './storedJSON';

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
  const parsed = readStoredJSON(STORAGE_PREFIX + sourceKey);
  const map = new Map<string, string>();
  if (typeof parsed !== 'object' || parsed == null) {
    return map;
  }
  for (const [path, fingerprint] of Object.entries(parsed)) {
    if (typeof fingerprint === 'string') {
      map.set(path, fingerprint);
    }
  }
  return map;
}

export function saveReviewedFiles(
  sourceKey: string,
  reviewed: ReadonlyMap<string, string>
): void {
  writeStoredJSON(
    STORAGE_PREFIX + sourceKey,
    reviewed.size === 0 ? null : Object.fromEntries(reviewed)
  );
}
