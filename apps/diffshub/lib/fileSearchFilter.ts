// Ranks a file listing against the go-to-file palette's query. Matching is
// case-insensitive and tiered: a substring hit in the file's basename beats a
// substring hit anywhere in the path, which beats a scattered subsequence
// match (every query character present in order, "usrref" → useRepoRefs.ts).
// Within a tier, earlier and tighter matches in shorter paths rank first, so
// typing a filename surfaces the file itself above deep paths that merely
// contain the letters.

export const MAX_FILE_SEARCH_RESULTS = 50;

// Score tiers are spaced far apart so the within-tier penalties (match
// position, spread, path length) can never promote a match across tiers.
const BASENAME_TIER = 300_000;
const PATH_TIER = 200_000;
const SUBSEQUENCE_TIER = 100_000;

function scorePath(lowerPath: string, query: string): number | null {
  const basenameStart = lowerPath.lastIndexOf('/') + 1;
  const basenameIndex = lowerPath.indexOf(query, basenameStart);
  if (basenameIndex >= basenameStart) {
    return BASENAME_TIER - (basenameIndex - basenameStart) * 100;
  }
  const pathIndex = lowerPath.indexOf(query);
  if (pathIndex >= 0) {
    return PATH_TIER - pathIndex * 100;
  }
  // In-order subsequence scan; a tighter first-to-last span ranks higher.
  let searchFrom = 0;
  let firstIndex = -1;
  let lastIndex = -1;
  for (const char of query) {
    const index = lowerPath.indexOf(char, searchFrom);
    if (index < 0) {
      return null;
    }
    if (firstIndex < 0) {
      firstIndex = index;
    }
    lastIndex = index;
    searchFrom = index + 1;
  }
  return SUBSEQUENCE_TIER - (lastIndex - firstIndex) * 10;
}

// Lowercased copies of each listing, keyed on the listing's identity: the
// palette re-filters the same (memoized) paths array on every keystroke, and
// re-lowercasing tens of thousands of paths per character is the dominant
// cost.
const loweredCache = new WeakMap<readonly string[], readonly string[]>();

function loweredPaths(paths: readonly string[]): readonly string[] {
  let lowered = loweredCache.get(paths);
  if (lowered == null) {
    lowered = paths.map((path) => path.toLowerCase());
    loweredCache.set(paths, lowered);
  }
  return lowered;
}

// The palette's result list: the top `limit` paths matching `query`, or the
// first `limit` paths verbatim while the query is empty (so opening the
// palette immediately shows the tree order).
export function filterFilePathsForSearch(
  paths: readonly string[],
  query: string,
  limit: number = MAX_FILE_SEARCH_RESULTS
): string[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') {
    return paths.slice(0, limit);
  }
  const lowered = loweredPaths(paths);
  const scored: { path: string; score: number }[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const score = scorePath(lowered[index], normalized);
    if (score != null) {
      // Prefer shorter paths on otherwise-equal matches.
      scored.push({ path, score: score - path.length });
    }
  }
  scored.sort((a, b) =>
    a.score === b.score ? a.path.localeCompare(b.path) : b.score - a.score
  );
  return scored.slice(0, limit).map((entry) => entry.path);
}
