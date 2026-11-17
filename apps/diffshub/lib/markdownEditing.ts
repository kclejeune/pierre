// Text replacing the selection, plus the new selection's offsets within it.
export interface MarkdownEdit {
  replacement: string;
  selectionEnd: number;
  selectionStart: number;
}

export type MarkdownFormat = 'bold' | 'code' | 'italic' | 'link';

const WRAPPERS: Record<Exclude<MarkdownFormat, 'link'>, string> = {
  bold: '**',
  code: '`',
  italic: '_',
};

// Cmd/Ctrl+B/I/E/K formatting. Wrapped text stays selected; an empty selection
// puts the caret between markers; links select the `url` placeholder.
export function formatSelection(
  selected: string,
  format: MarkdownFormat
): MarkdownEdit {
  if (format === 'link') {
    const label = selected === '' ? 'text' : selected;
    const replacement = `[${label}](url)`;
    const urlStart = label.length + 3;
    return {
      replacement,
      selectionEnd: urlStart + 3,
      selectionStart: urlStart,
    };
  }
  const marker = WRAPPERS[format];
  return {
    replacement: `${marker}${selected}${marker}`,
    selectionEnd: marker.length + selected.length,
    selectionStart: marker.length,
  };
}

// A single bare http(s) URL; pasting one over a selection makes a link.
export function isPastedURL(text: string): boolean {
  if (!/^https?:\/\/\S+$/.test(text)) {
    return false;
  }
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

// Pasting a URL over selected text: `[selected](url)`, caret after it.
export function linkSelectionTo(selected: string, url: string): MarkdownEdit {
  const replacement = `[${selected}](${url})`;
  return {
    replacement,
    selectionEnd: replacement.length,
    selectionStart: replacement.length,
  };
}

// Toolbar formats that prefix each selected line rather than wrapping the
// selection.
export type MarkdownLineFormat =
  | MarkdownHeadingFormat
  | 'ordered-list'
  | 'quote'
  | 'task-list'
  | 'unordered-list';

// The heading levels the toolbar offers, as `#`, `##`, and `###` prefixes.
export type MarkdownHeadingFormat = 'heading-1' | 'heading-2' | 'heading-3';

export const HEADING_FORMATS: readonly MarkdownHeadingFormat[] = [
  'heading-1',
  'heading-2',
  'heading-3',
];

function isHeadingFormat(
  format: MarkdownLineFormat
): format is MarkdownHeadingFormat {
  return (HEADING_FORMATS as readonly string[]).includes(format);
}

// Any ATX heading prefix, whatever its level.
const ANY_HEADING_PREFIX = /^#{1,6} /;

// Matches a line that already carries the format's prefix, so pressing the
// button again strips it (GitHub toggles the same way). Each heading pattern
// matches its exact level only: `## ` is not a `# ` heading, so choosing a
// different level switches the line instead of stripping it.
const LINE_PREFIX_PATTERNS: Record<MarkdownLineFormat, RegExp> = {
  'heading-1': /^# /,
  'heading-2': /^## /,
  'heading-3': /^### /,
  'ordered-list': /^\d+\. /,
  quote: /^> ?/,
  'task-list': /^[-*] \[[ xX]\] /,
  'unordered-list': /^[-*] (?!\[[ xX]\] )/,
};

// What adding a format strips first, so switching between list styles
// replaces the old marker instead of stacking a second one.
const ANY_LIST_PREFIX = /^(?:[-*] \[[ xX]\] |[-*] |\d+\. )/;

function existingPrefix(format: MarkdownLineFormat): RegExp {
  if (isHeadingFormat(format)) {
    return ANY_HEADING_PREFIX;
  }
  return format === 'quote' ? LINE_PREFIX_PATTERNS.quote : ANY_LIST_PREFIX;
}

// The prefix each format adds; ordered lists number their lines instead.
const LINE_PREFIXES: Record<
  Exclude<MarkdownLineFormat, 'ordered-list'>,
  string
> = {
  'heading-1': '# ',
  'heading-2': '## ',
  'heading-3': '### ',
  quote: '> ',
  'task-list': '- [ ] ',
  'unordered-list': '- ',
};

function linePrefix(format: MarkdownLineFormat, index: number): string {
  return format === 'ordered-list' ? `${index + 1}. ` : LINE_PREFIXES[format];
}

// A line-format edit: the [start, end) range of `value` to replace (the
// selection widened to whole lines) and the replacement for it.
export interface MarkdownLineEdit {
  edit: MarkdownEdit;
  end: number;
  start: number;
}

// Heading, quote, and list toolbar buttons. Widens the selection to whole
// lines, then adds the format's prefix to every non-blank line, or removes it
// when every non-blank line already has it. A caret on one line stays a caret
// (moved past the prefix); a multi-line selection stays selected.
export function formatLines(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: MarkdownLineFormat
): MarkdownLineEdit {
  const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
  // A selection ending right after a newline does not include the next line.
  const effectiveEnd =
    selectionEnd > selectionStart && value[selectionEnd - 1] === '\n'
      ? selectionEnd - 1
      : selectionEnd;
  const newline = value.indexOf('\n', effectiveEnd);
  const end = newline === -1 ? value.length : newline;
  const lines = value.slice(start, end).split('\n');
  const pattern = LINE_PREFIX_PATTERNS[format];
  const contentLines = lines.filter((line) => line.trim() !== '');
  const removing =
    contentLines.length > 0 && contentLines.every((line) => pattern.test(line));
  let numbered = 0;
  const replacement = lines
    .map((line) => {
      if (removing) {
        return line.replace(pattern, '');
      }
      if (line.trim() === '' && lines.length > 1) {
        return line;
      }
      return `${linePrefix(format, numbered++)}${line.replace(existingPrefix(format), '')}`;
    })
    .join('\n');
  // A caret on a single line keeps its offset from the line's end; anything
  // else selects the whole rewritten block.
  const keepCaret = lines.length === 1 && selectionStart === selectionEnd;
  const caret = Math.max(0, selectionStart - end + replacement.length);
  return {
    edit: {
      replacement,
      selectionEnd: keepCaret ? caret : replacement.length,
      selectionStart: keepCaret ? caret : 0,
    },
    end,
    start,
  };
}

// Everything the editor toolbar and shortcuts can do to the text.
export type MarkdownAction = MarkdownFormat | MarkdownLineFormat | 'mention';

const LINE_FORMATS: ReadonlySet<MarkdownAction> = new Set<MarkdownLineFormat>([
  ...HEADING_FORMATS,
  'ordered-list',
  'quote',
  'task-list',
  'unordered-list',
]);

function isLineFormat(action: MarkdownAction): action is MarkdownLineFormat {
  return LINE_FORMATS.has(action);
}

// One entry point for every toolbar button and formatting shortcut: the range
// of `value` to replace and the edit for it. Inline formats replace just the
// selection; line formats widen it to whole lines; a mention inserts `@`
// (space-separated from a preceding word) before the selection.
export function editMarkdown(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  action: MarkdownAction
): MarkdownLineEdit {
  if (isLineFormat(action)) {
    return formatLines(value, selectionStart, selectionEnd, action);
  }
  const selected = value.slice(selectionStart, selectionEnd);
  if (action === 'mention') {
    const before = value.slice(0, selectionStart);
    const prefix = before === '' || /\s$/.test(before) ? '@' : ' @';
    const replacement = `${prefix}${selected}`;
    return {
      edit: {
        replacement,
        selectionEnd: replacement.length,
        selectionStart: replacement.length,
      },
      end: selectionEnd,
      start: selectionStart,
    };
  }
  return {
    edit: formatSelection(selected, action),
    end: selectionEnd,
    start: selectionStart,
  };
}

// The heading level of the line holding the caret (the selection's first
// line), so the heading menu can mark the level a click would remove.
export function headingFormatAt(
  value: string,
  selectionStart: number
): MarkdownHeadingFormat | null {
  const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const newline = value.indexOf('\n', start);
  const line = value.slice(start, newline === -1 ? value.length : newline);
  return (
    HEADING_FORMATS.find((format) => LINE_PREFIX_PATTERNS[format].test(line)) ??
    null
  );
}
