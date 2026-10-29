import { diffArrays } from 'diff';

// Line-level three-way merge, ported from node-diff3's diff3Merge (MIT; see
// ../NOTICE.md) but built on jsdiff's Myers diff. node-diff3's LCS does a
// linear candidate scan per matching line, which goes roughly cubic on large
// files with many repeated lines (lockfiles, generated code) and pinned the
// server's event loop for minutes.
//
// Myers costs roughly the square of the edit distance, so each two-way diff is
// capped by edit count rather than wall time: Cloudflare Workers freeze
// Date.now() during synchronous execution, so a jsdiff `timeout` never fires
// there. Past the cap the diff degrades to one coarse hunk instead of failing.

// Upper bound on the Myers edit distance per two-way diff. About 0.35s of CPU
// at the cap; the cost grows quadratically past it.
const MAX_DIFF_EDIT_LENGTH = 1000;

type Diff3Region =
  | { ok: string[] }
  | { conflict: { a: string[]; b: string[]; o: string[] } };

// A span of `o` that one side replaced: o[oStart, oStart + oLength) became
// side[abStart, abStart + abLength).
interface Hunk {
  ab: 'a' | 'b';
  abLength: number;
  abStart: number;
  oLength: number;
  oStart: number;
}

// A cheap lower bound on the edit distance between two line arrays. Every
// common line pairs with at most one equal line on the other side, so the
// longest common subsequence is at most the multiset intersection, and the
// edit distance (deletions plus insertions) is at least the rest. Lets wholly
// rewritten files skip a Myers run that is certain to hit the cap.
function minEditLength(left: string[], right: string[]): number {
  const counts = new Map<string, number>();
  for (const line of left) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let shared = 0;
  for (const line of right) {
    const count = counts.get(line) ?? 0;
    if (count > 0) {
      counts.set(line, count - 1);
      shared += 1;
    }
  }
  return left.length + right.length - 2 * shared;
}

// Returns the hunks where `side` differs from `o`. The common prefix is
// skipped before the Myers diff (which would consume it first anyway). If the
// rest needs more than `maxEditLength` edits, everything between the common
// prefix and suffix becomes a single replaced hunk: still a correct diff, just
// coarser, so a concurrent change on the other side anywhere in it surfaces as
// one larger conflict. The common suffix is only used for that fallback and
// for the cheap bound: trimming it from the Myers input would shift where
// ambiguous repeated lines align, and with them which regions conflict.
function diffHunks(
  o: string[],
  side: string[],
  ab: 'a' | 'b',
  maxEditLength: number
): Hunk[] {
  let prefix = 0;
  while (
    prefix < o.length &&
    prefix < side.length &&
    o[prefix] === side[prefix]
  ) {
    prefix += 1;
  }
  if (prefix === o.length && prefix === side.length) {
    return [];
  }
  let suffix = 0;
  while (
    suffix < o.length - prefix &&
    suffix < side.length - prefix &&
    o[o.length - 1 - suffix] === side[side.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oMiddleLength = o.length - prefix - suffix;
  const sideMiddleLength = side.length - prefix - suffix;
  // The edit distance cannot exceed the middle's total length, so the bound
  // is only worth computing when the middle is longer than the cap.
  const beyondCap =
    oMiddleLength + sideMiddleLength > maxEditLength &&
    minEditLength(
      o.slice(prefix, o.length - suffix),
      side.slice(prefix, side.length - suffix)
    ) > maxEditLength;
  const changes = beyondCap
    ? undefined
    : diffArrays(o.slice(prefix), side.slice(prefix), { maxEditLength });
  if (changes == null) {
    return [
      {
        ab,
        abLength: sideMiddleLength,
        abStart: prefix,
        oLength: oMiddleLength,
        oStart: prefix,
      },
    ];
  }
  const hunks: Hunk[] = [];
  let oIndex = prefix;
  let sideIndex = prefix;
  let pending: Hunk | null = null;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (pending != null) {
        hunks.push(pending);
        pending = null;
      }
      oIndex += change.count;
      sideIndex += change.count;
      continue;
    }
    pending ??= {
      ab,
      abLength: 0,
      abStart: sideIndex,
      oLength: 0,
      oStart: oIndex,
    };
    if (change.removed) {
      pending.oLength += change.count;
      oIndex += change.count;
    } else {
      pending.abLength += change.count;
      sideIndex += change.count;
    }
  }
  if (pending != null) {
    hunks.push(pending);
  }
  return hunks;
}

function sameLines(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}

// Merges `a` and `b`, two edits of the common ancestor `o`. Regions only one
// side changed (or both changed identically) merge cleanly; overlapping
// changes become conflict regions.
export function diff3Merge(
  a: string[],
  o: string[],
  b: string[],
  maxEditLength = MAX_DIFF_EDIT_LENGTH
): Diff3Region[] {
  const aHunks = diffHunks(o, a, 'a', maxEditLength);
  const bHunks = diffHunks(o, b, 'b', maxEditLength);
  const hunks = [...aHunks, ...bHunks].sort(
    (left, right) => left.oStart - right.oStart
  );

  const regions: Diff3Region[] = [];
  let okLines: string[] = [];
  const flushOk = () => {
    if (okLines.length > 0) {
      regions.push({ ok: okLines });
      okLines = [];
    }
  };
  let oOffset = 0;
  let index = 0;
  while (index < hunks.length) {
    const first = hunks[index];
    const regionStart = first.oStart;
    let regionEnd = first.oStart + first.oLength;
    const regionHunks = [first];
    index += 1;
    // Pull in every following hunk that overlaps or touches this region.
    while (index < hunks.length && hunks[index].oStart <= regionEnd) {
      const next = hunks[index];
      regionEnd = Math.max(regionEnd, next.oStart + next.oLength);
      regionHunks.push(next);
      index += 1;
    }
    okLines.push(...o.slice(oOffset, regionStart));

    if (regionHunks.length === 1) {
      const side = first.ab === 'a' ? a : b;
      okLines.push(
        ...side.slice(first.abStart, first.abStart + first.abLength)
      );
    } else {
      // Collapse each side's hunks into one span, then widen it by the parts
      // of the region only the other side touched (those lines are unchanged
      // on this side, so the offset into `o` maps one-to-one).
      const emptyBounds = (side: string[]) => ({
        abEnd: -1,
        abStart: side.length,
        oEnd: -1,
        oStart: o.length,
      });
      const bounds = { a: emptyBounds(a), b: emptyBounds(b) };
      for (const hunk of regionHunks) {
        const bound = bounds[hunk.ab];
        bound.abStart = Math.min(hunk.abStart, bound.abStart);
        bound.abEnd = Math.max(hunk.abStart + hunk.abLength, bound.abEnd);
        bound.oStart = Math.min(hunk.oStart, bound.oStart);
        bound.oEnd = Math.max(hunk.oStart + hunk.oLength, bound.oEnd);
      }
      const sideSpan = (side: string[], bound: typeof bounds.a) =>
        side.slice(
          bound.abStart + (regionStart - bound.oStart),
          bound.abEnd + (regionEnd - bound.oEnd)
        );
      const aLines = sideSpan(a, bounds.a);
      const bLines = sideSpan(b, bounds.b);
      if (sameLines(aLines, bLines)) {
        okLines.push(...aLines);
      } else {
        flushOk();
        regions.push({
          conflict: {
            a: aLines,
            b: bLines,
            o: o.slice(regionStart, regionEnd),
          },
        });
      }
    }
    oOffset = regionEnd;
  }
  okLines.push(...o.slice(oOffset));
  flushOk();
  return regions;
}
