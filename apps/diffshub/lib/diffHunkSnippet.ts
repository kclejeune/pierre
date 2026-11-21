// One line of a review comment's code snippet.
export interface DiffHunkSnippetLine {
  kind: 'addition' | 'context' | 'deletion';
  // The line's number on its own side: the old file's for a deletion, the
  // new file's for an addition, and for context the side the thread is on.
  // Null when the hunk header couldn't be read.
  lineNumber: number | null;
  text: string;
}

// How many of a hunk's lines the snippet shows, ending at the commented
// line, as GitHub does for a thread whose line has left the diff.
export const DIFF_HUNK_SNIPPET_LINES = 4;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// The last `count` lines of a review comment's `diff_hunk`. GitHub cuts
// the hunk off at the commented line, so its last line is the one the
// thread was written on; for an outdated thread that line is no longer in
// the diff, and this snippet is the only view of it left. `side` picks
// which file numbers context lines, so they match the thread's own line.
export function readDiffHunkSnippet(
  hunk: string,
  side: 'LEFT' | 'RIGHT' = 'RIGHT',
  count = DIFF_HUNK_SNIPPET_LINES
): DiffHunkSnippetLine[] {
  const lines: DiffHunkSnippetLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  for (const raw of hunk.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header != null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    // "\ No newline at end of file", and the blank a trailing newline leaves.
    if (raw === '' || raw.startsWith('\\')) {
      continue;
    }
    const sigil = raw[0];
    const text = raw.slice(1);
    if (sigil === '+') {
      lines.push({ kind: 'addition', lineNumber: newLine, text });
      newLine = newLine == null ? null : newLine + 1;
    } else if (sigil === '-') {
      lines.push({ kind: 'deletion', lineNumber: oldLine, text });
      oldLine = oldLine == null ? null : oldLine + 1;
    } else {
      lines.push({
        kind: 'context',
        lineNumber: side === 'LEFT' ? oldLine : newLine,
        text,
      });
      oldLine = oldLine == null ? null : oldLine + 1;
      newLine = newLine == null ? null : newLine + 1;
    }
  }
  return lines.slice(-count);
}
