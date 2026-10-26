import type { DiffsHubFileTreeSource } from './types';

// Shared "nothing hidden" value, so callers can skip work by identity.
export const NO_HIDDEN_ITEM_IDS: ReadonlySet<string> = new Set();

// Collects the item ids of files the sidebar tree is not showing, so the
// viewer can collapse them and agree with the tree. When the tree search is
// narrowing, its file matches decide visibility on their own: the search runs
// over the tree built from `filteredSource`, so its matches already exclude
// paths the Git-status filter dropped. Otherwise visibility is membership in
// `filteredSource`.
export function getHiddenTreeItemIds(
  source: DiffsHubFileTreeSource,
  filteredSource: DiffsHubFileTreeSource,
  statusFiltered: boolean,
  searchMatchPaths: ReadonlySet<string> | null
): ReadonlySet<string> {
  if (!statusFiltered && searchMatchPaths == null) {
    return NO_HIDDEN_ITEM_IDS;
  }
  const visible = searchMatchPaths ?? filteredSource.pathToItemId;
  const hidden = new Set<string>();
  for (const [path, itemId] of source.pathToItemId) {
    if (!visible.has(path)) {
      hidden.add(itemId);
    }
  }
  return hidden;
}
