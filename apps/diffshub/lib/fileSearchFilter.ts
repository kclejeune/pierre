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
  return rankPathMatches(paths, query, limit).map((match) => match.path);
}

// The ranking order for two scored paths: negative when `a` ranks first.
// Higher scores first, then localeCompare; callers break remaining ties by
// input order.
export function compareRankedPaths(
  a: { path: string; score: number },
  b: { path: string; score: number }
): number {
  return a.score === b.score ? a.path.localeCompare(b.path) : b.score - a.score;
}

// One ranked match: the matched path, its index into the searched array,
// and its score (see compareRankedPaths).
export interface PathMatch {
  index: number;
  path: string;
  score: number;
}

// The ranking with scores, so matches from several arrays ranked separately
// can be merged in the order one combined ranking would give. Empty queries
// score every path 0.
//
// Keeps only the best `limit` matches while scanning (a sorted window with
// binary-search insertion), so a large list costs one pass plus O(limit)
// work per match that beats the current worst, instead of sorting every
// match. Order is identical to sorting all matches: score descending, then
// localeCompare, then input order.
export function rankPathMatches(
  paths: readonly string[],
  query: string,
  limit: number = MAX_FILE_SEARCH_RESULTS
): PathMatch[] {
  const normalized = query.trim().toLowerCase();
  const count = Math.max(0, Math.min(limit, paths.length));
  if (normalized === '') {
    return Array.from({ length: count }, (_, index) => ({
      index,
      path: paths[index],
      score: 0,
    }));
  }
  if (count === 0) {
    return [];
  }
  const lowered = loweredPaths(paths);
  const top: PathMatch[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const score = scorePath(lowered[index], normalized);
    if (score == null) {
      continue;
    }
    // Prefer shorter paths on otherwise-equal matches.
    const path = paths[index];
    const entry = { index, path, score: score - path.length };
    if (
      top.length === count &&
      compareRankedPaths(entry, top[count - 1]) >= 0
    ) {
      continue;
    }
    // Insert after every entry that ranks ahead or ties, so ties keep input
    // order like a stable sort.
    let low = 0;
    let high = top.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareRankedPaths(top[middle], entry) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    top.splice(low, 0, entry);
    if (top.length > count) {
      top.pop();
    }
  }
  return top;
}
