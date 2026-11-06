import { cleanLastNewline, type FileDiffMetadata } from '@pierre/diffs';

// GitHub "suggested changes": a ```suggestion fence in a review comment
// replaces the comment's anchored lines (on the head side) with the fence's
// contents, and "Commit suggestion" lands that replacement on the pull's head
// branch. These helpers read the anchored lines out of a rendered diff, build
// the fence a reviewer starts from, and apply a suggestion to file contents.

// Whether a comment body holds a ```suggestion fence (of any fence length).
export function hasSuggestion(body: string): boolean {
  return /^ {0,3}`{3,}suggestion\b/m.test(body);
}

// The head-side text of lines `start`..`end` (1-based, inclusive), without
// trailing newlines, or null when any of them isn't in the diff (a partial
// diff only carries the lines its hunks show) or the range isn't on lines
// (file-level comments sit at line 0).
export function getNewFileLines(
  fileDiff: FileDiffMetadata,
  start: number,
  end: number
): string[] | null {
  if (start < 1) {
    return null;
  }
  const lines: string[] = [];
  for (let line = start; line <= end; line++) {
    const text = readNewFileLine(fileDiff, line);
    if (text == null) {
      return null;
    }
    lines.push(cleanLastNewline(text));
  }
  return lines;
}

function readNewFileLine(
  fileDiff: FileDiffMetadata,
  line: number
): string | undefined {
  if (!fileDiff.isPartial) {
    return fileDiff.additionLines[line - 1];
  }
  for (const hunk of fileDiff.hunks) {
    const offset = line - hunk.additionStart;
    if (offset >= 0 && offset < hunk.additionCount) {
      return fileDiff.additionLines[hunk.additionLineIndex + offset];
    }
  }
  return undefined;
}

// The fence a "Suggest change" starts a comment with: the anchored lines,
// ready to edit. A fence longer than any backtick run inside keeps the
// suggestion intact.
export function buildSuggestionBlock(lines: readonly string[]): string {
  const longestRun = Math.max(
    0,
    ...lines.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length)
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}suggestion\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}${fence}`;
}

// `contents` with lines `start`..`end` (1-based, inclusive) replaced by
// `suggestion`, keeping the file's line endings and its final newline. Null
// when the range is outside the file.
export function applySuggestion(
  contents: string,
  start: number,
  end: number,
  suggestion: string
): string | null {
  const eol = contents.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = contents.endsWith('\n');
  const lines = contents.split(/\r?\n/);
  if (hadFinalNewline) {
    lines.pop();
  }
  if (start < 1 || end < start || end > lines.length) {
    return null;
  }
  const replacement = suggestion === '' ? [] : suggestion.split(/\r?\n/);
  lines.splice(start - 1, end - start + 1, ...replacement);
  return lines.join(eol) + (hadFinalNewline && lines.length > 0 ? eol : '');
}
