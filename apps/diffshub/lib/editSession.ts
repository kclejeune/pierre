// Pure state helpers for the pull-request edit session: the ordered list of
// files with uncommitted editor changes. The list holds membership only —
// latest contents live in a ref keyed by itemId, so the editor's
// per-keystroke onChange never produces a new list (which would re-render the
// whole viewer). Kept out of the hook so list rules (dedupe by item, stable
// ordering, message defaults) are unit-testable.

export interface DirtyFileEntry {
  itemId: string;
  // Repository-relative path (the diff's new-side name).
  path: string;
}

// Adds an entry for a newly dirty item, keeping first-edited-first order so
// the commit panel list stays stable. Returns the input array unchanged when
// the item is already tracked — callers pass this to a state setter, and an
// identical reference means no re-render.
export function upsertDirtyFile(
  entries: readonly DirtyFileEntry[],
  entry: DirtyFileEntry
): readonly DirtyFileEntry[] {
  const existing = entries.find(
    (candidate) => candidate.itemId === entry.itemId
  );
  if (existing == null) {
    return [...entries, entry];
  }
  return existing.path === entry.path
    ? entries
    : entries.map((candidate) =>
        candidate.itemId === entry.itemId ? entry : candidate
      );
}

export function removeDirtyFile(
  entries: readonly DirtyFileEntry[],
  itemId: string
): readonly DirtyFileEntry[] {
  return entries.filter((entry) => entry.itemId !== itemId);
}

// "Update src/app.ts" for one file, "Update 3 files" otherwise.
export function defaultCommitMessage(
  entries: readonly DirtyFileEntry[]
): string {
  if (entries.length === 1) {
    return `Update ${entries[0].path}`;
  }
  return `Update ${entries.length} files`;
}
