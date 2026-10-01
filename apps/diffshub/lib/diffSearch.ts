import { cleanLastNewline, type FileDiffMetadata } from '@pierre/diffs';

// Content search over the files of a diff. The viewer virtualizes both files
// and lines, so the browser's own find only sees the handful of rows that are
// mounted; these helpers search the diff's line arrays directly instead and
// report matches as (item, side, line number, column range) so callers can
// scroll to and highlight them.

const MAX_DIFF_SEARCH_MATCHES = 5_000;

export type DiffSearchSide = 'additions' | 'deletions';
export type DiffSearchLineKind = 'context' | 'addition' | 'deletion';

export interface DiffSearchQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface DiffSearchLine {
  side: DiffSearchSide;
  kind: DiffSearchLineKind;
  // One-based line number on `side`'s version of the file.
  lineNumber: number;
  // Line contents without the trailing newline.
  text: string;
}

export interface DiffSearchSource {
  itemId: string;
  path: string;
  fileDiff: FileDiffMetadata;
}

export interface DiffSearchMatch {
  itemId: string;
  path: string;
  side: DiffSearchSide;
  kind: DiffSearchLineKind;
  lineNumber: number;
  // UTF-16 column range of the match within `lineText`, end exclusive.
  start: number;
  end: number;
  lineText: string;
}

// Where a match (or a navigation target) sits: enough to scroll to it and to
// highlight its columns.
export type DiffLocation = Pick<
  DiffSearchMatch,
  'itemId' | 'side' | 'lineNumber' | 'start' | 'end'
>;

export interface DiffSearchResult {
  matches: DiffSearchMatch[];
  // True when the match cap was hit and later matches were dropped.
  truncated: boolean;
}

type CompiledDiffSearch =
  | { type: 'empty' }
  | { type: 'error'; message: string }
  | { type: 'pattern'; pattern: RegExp };

// Characters that make up an identifier for whole-word matching. `$` is
// included so `$foo` and `foo$` behave like the JS identifiers they are.
const WORD_CHAR = '[A-Za-z0-9_$]';

// Turns the find input and its toggles into a global RegExp. Plain text is
// escaped; whole-word wraps the pattern in identifier-boundary lookarounds
// rather than `\b`, which treats `$` as a boundary.
export function compileDiffSearchQuery(
  query: DiffSearchQuery
): CompiledDiffSearch {
  if (query.text === '') {
    return { type: 'empty' };
  }
  const escaped = query.regex ? query.text : escapeRegExp(query.text);
  const source = query.wholeWord ? wrapWholeWord(escaped) : escaped;
  try {
    return {
      type: 'pattern',
      pattern: new RegExp(source, query.caseSensitive ? 'g' : 'gi'),
    };
  } catch (error) {
    return {
      type: 'error',
      message: error instanceof Error ? error.message : 'Invalid pattern',
    };
  }
}

// Restricts a pattern source to whole identifiers.
export function wrapWholeWord(source: string): string {
  return `(?<!${WORD_CHAR})(?:${source})(?!${WORD_CHAR})`;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Column ranges of every non-empty match of `pattern` in `text`. Zero-width
// matches (e.g. a lone `^` regex) are skipped so they cannot stall the loop
// or produce invisible highlights.
export function findMatchesInLine(
  text: string,
  pattern: RegExp
): Array<[start: number, end: number]> {
  const ranges: Array<[number, number]> = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) != null) {
    if (match[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

// Visits every line a reader can see in this diff, in display order. Context
// lines exist on both sides but are reported once, on the additions side, so
// a match in unchanged code is not listed twice. Partial (patch-only) diffs
// only hold hunk lines; hydrated diffs also yield the unchanged lines between
// and after hunks. Returning `false` from `visit` stops the walk.
export function forEachDiffSearchLine(
  fileDiff: FileDiffMetadata,
  visit: (line: DiffSearchLine) => boolean | void
): void {
  const { additionLines, deletionLines, isPartial } = fileDiff;
  let additionCursor = 1;

  const visitGap = (end: number): boolean => {
    if (isPartial) {
      return true;
    }
    for (let lineNumber = additionCursor; lineNumber < end; lineNumber++) {
      const text = additionLines[lineNumber - 1];
      if (text == null) {
        return true;
      }
      if (
        visit({
          side: 'additions',
          kind: 'context',
          lineNumber,
          text: cleanLastNewline(text),
        }) === false
      ) {
        return false;
      }
    }
    return true;
  };

  for (const hunk of fileDiff.hunks) {
    // A side with zero lines in the hunk header (`+12,0`) names the line
    // before the hunk, so the hunk's first line on that side is one past it.
    let additionLine =
      hunk.additionCount > 0 ? hunk.additionStart : hunk.additionStart + 1;
    let deletionLine =
      hunk.deletionCount > 0 ? hunk.deletionStart : hunk.deletionStart + 1;
    if (!visitGap(additionLine)) {
      return;
    }
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let offset = 0; offset < content.lines; offset++) {
          const text = additionLines[content.additionLineIndex + offset];
          if (
            text != null &&
            visit({
              side: 'additions',
              kind: 'context',
              lineNumber: additionLine + offset,
              text: cleanLastNewline(text),
            }) === false
          ) {
            return;
          }
        }
        additionLine += content.lines;
        deletionLine += content.lines;
        continue;
      }
      for (let offset = 0; offset < content.deletions; offset++) {
        const text = deletionLines[content.deletionLineIndex + offset];
        if (
          text != null &&
          visit({
            side: 'deletions',
            kind: 'deletion',
            lineNumber: deletionLine + offset,
            text: cleanLastNewline(text),
          }) === false
        ) {
          return;
        }
      }
      for (let offset = 0; offset < content.additions; offset++) {
        const text = additionLines[content.additionLineIndex + offset];
        if (
          text != null &&
          visit({
            side: 'additions',
            kind: 'addition',
            lineNumber: additionLine + offset,
            text: cleanLastNewline(text),
          }) === false
        ) {
          return;
        }
      }
      deletionLine += content.deletions;
      additionLine += content.additions;
    }
    additionCursor = additionLine;
  }
  visitGap(additionLines.length + 1);
}

// Searches every source in order and collects matches up to `limit`.
export function searchDiffSources(
  sources: Iterable<DiffSearchSource>,
  pattern: RegExp,
  limit = MAX_DIFF_SEARCH_MATCHES
): DiffSearchResult {
  const matches: DiffSearchMatch[] = [];
  let truncated = false;
  for (const { itemId, path, fileDiff } of sources) {
    forEachDiffSearchLine(fileDiff, (line) => {
      for (const [start, end] of findMatchesInLine(line.text, pattern)) {
        if (matches.length >= limit) {
          truncated = true;
          return false;
        }
        matches.push({
          itemId,
          path,
          side: line.side,
          kind: line.kind,
          lineNumber: line.lineNumber,
          start,
          end,
          lineText: line.text,
        });
      }
      return true;
    });
    if (truncated) {
      break;
    }
  }
  return { matches, truncated };
}

// Buckets matches by item, preserving their order within each item.
export function groupMatchesByItem<T extends { itemId: string }>(
  matches: readonly T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const match of matches) {
    const group = groups.get(match.itemId);
    if (group == null) {
      groups.set(match.itemId, [match]);
    } else {
      group.push(match);
    }
  }
  return groups;
}

// Identity used to tell whether two matches are the same hit, e.g. to keep
// the active match selected across a re-search.
export function getDiffSearchMatchKey(match: DiffLocation): string {
  return `${match.itemId}\0${match.side}\0${match.lineNumber}\0${match.start}`;
}
