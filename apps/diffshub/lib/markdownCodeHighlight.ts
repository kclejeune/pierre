import { canUseWASM } from '@pierre/diffs';
import type { ThemedToken } from '@pierre/highlights';
import { cssVariables } from '@pierre/highlights/themes';

type HighlightsModule = typeof import('@pierre/highlights');

// Fences past this size render as plain text: tokenizing runs synchronously
// on the render that mounts the block, and a pasted log or lockfile in a
// comment shouldn't stall the page for the sake of colors.
export const MAX_HIGHLIGHTED_FENCE_LENGTH = 100_000;

// Lines at least this long become a single unstyled token, which keeps
// minified one-liners from producing thousands of spans.
const MAX_TOKENIZED_LINE_LENGTH = 2_000;

let loadedModule: HighlightsModule | null = null;
let loadingModule: Promise<HighlightsModule | null> | null = null;

// The highlights module once loadHighlights() has resolved, or null. Lets a
// code block that mounts after the first load tokenize on its first render
// instead of flashing plain text.
export function getLoadedHighlights(): HighlightsModule | null {
  return loadedModule;
}

// Loads @pierre/highlights on demand. The module embeds its WebAssembly, so it
// is imported dynamically (the same chunk the diffs highlighter loads) rather
// than pulled into every page that renders markdown. Resolves to null when
// WebAssembly is unavailable or the import fails, in which case fences stay
// plain text.
export function loadHighlights(): Promise<HighlightsModule | null> {
  if (loadingModule != null) {
    return loadingModule;
  }
  if (!canUseWASM()) {
    loadingModule = Promise.resolve(null);
    return loadingModule;
  }
  loadingModule = import('@pierre/highlights').then(
    (module) => {
      loadedModule = module;
      return module;
    },
    (error: unknown) => {
      console.error('Failed to load the markdown code highlighter', error);
      return null;
    }
  );
  return loadingModule;
}

// Tokenizes a fenced code block's source for display, one token array per
// line, or returns null when the fence should render as plain text (unknown
// language or oversized input). Token colors are `var(--diffs-token-*)`
// references into the css-variables theme, the same custom properties the
// diff views fill from the active theme (see useHighlightTheme), so code in
// markdown recolors with the theme cycle without re-tokenizing.
export function tokenizeFence(
  highlights: HighlightsModule,
  source: string,
  language: string
): ThemedToken[][] | null {
  if (
    source.length > MAX_HIGHLIGHTED_FENCE_LENGTH ||
    !highlights.isSupportedLanguage(language)
  ) {
    return null;
  }
  // The fence body ends with the newline before the closing fence; drop it so
  // it doesn't produce an empty trailing line.
  const code = source.endsWith('\n') ? source.slice(0, -1) : source;
  return highlights.codeToTokens(code, {
    cssVariablePrefix: '--diffs-token-',
    lang: language,
    theme: cssVariables,
    tokenizeMaxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  }).tokens;
}

// Inline styles for one token. fontStyle uses Shiki's bit flags (italic 1,
// bold 2, underline 4, strikethrough 8).
export function tokenStyle(token: ThemedToken): React.CSSProperties {
  const flags = token.fontStyle ?? 0;
  const decorations = [
    (flags & 4) !== 0 ? 'underline' : null,
    (flags & 8) !== 0 ? 'line-through' : null,
  ].filter((value) => value != null);
  return {
    color: token.color,
    backgroundColor: token.bgColor,
    fontStyle: (flags & 1) !== 0 ? 'italic' : undefined,
    fontWeight: (flags & 2) !== 0 ? 'bold' : undefined,
    textDecoration: decorations.length > 0 ? decorations.join(' ') : undefined,
  };
}
