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
