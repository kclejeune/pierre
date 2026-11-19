import {
  type DiffsHighlighter,
  formatCSSVariablePrefix,
  getHighlighterIfLoaded,
  getSharedHighlighter,
} from '@pierre/diffs';

import { getPreferredHighlighter } from './preferredHighlighter';
import { HIGHLIGHT_THEME_NAME } from './theme/highlightTheme';

// Fences past this size render as plain text: highlighting runs synchronously
// on the render that mounts the block, and a pasted log or lockfile in a
// comment shouldn't stall the page for the sake of colors.
export const MAX_HIGHLIGHTED_FENCE_LENGTH = 100_000;

// The attribute that marks a highlighted markdown code block. The token
// palette stylesheet rule targets it.
export const CODE_PALETTE_ATTRIBUTE = 'data-diffshub-code';

const CODE_PALETTE_STYLE_ID = 'diffshub-markdown-code-palette';

// Only the highlights backend renders the css-variables theme; under the
// shiki-js fallback (no WebAssembly) fences stay plain text.
function usable(
  highlighter: DiffsHighlighter | undefined
): DiffsHighlighter | null {
  return highlighter?.name === 'highlights' ? highlighter : null;
}

// The page's shared highlighter when it is already loaded with the
// css-variables theme, or null. PreloadHighlighter warms it on every page, so
// most code blocks highlight on their first render.
export function getLoadedHighlighter(): DiffsHighlighter | null {
  if (getPreferredHighlighter() !== 'highlights') return null;
  return usable(getHighlighterIfLoaded({ theme: HIGHLIGHT_THEME_NAME }));
}

// Waits for the page's shared highlighter (the same instance the diff views
// and PreloadHighlighter use) with the css-variables theme attached. Resolves
// to null when highlights can't be used here or loading fails; the shared
// highlighter clears a failed load, so a later call retries.
export async function loadHighlighter(): Promise<DiffsHighlighter | null> {
  if (getPreferredHighlighter() !== 'highlights') return null;
  try {
    return usable(
      await getSharedHighlighter({
        themes: [HIGHLIGHT_THEME_NAME],
        langs: [],
        preferredHighlighter: 'highlights',
      })
    );
  } catch (error) {
    console.error('Failed to load the markdown code highlighter', error);
    return null;
  }
}

// Highlights a fenced code block's source and returns the escaped HTML for
// the inside of its <code> element, or null when the fence should render as
// plain text (oversized input or a highlighter error). Unknown languages
// highlight as plain `text`. Token colors are `var(--diffs-token-*)`
// references into the css-variables theme, filled by the palette rule
// (installCodePalette), so code recolors with the theme without being
// highlighted again.
export function highlightFence(
  highlighter: DiffsHighlighter,
  source: string,
  language: string
): string | null {
  if (source.length > MAX_HIGHLIGHTED_FENCE_LENGTH) return null;
  // The fence body ends with the newline before the closing fence; drop it so
  // it doesn't produce an empty trailing line.
  const code = source.endsWith('\n') ? source.slice(0, -1) : source;
  let html: string;
  try {
    html = highlighter.codeToHtml(code, {
      cssVariablePrefix: formatCSSVariablePrefix('token'),
      lang: language,
      theme: HIGHLIGHT_THEME_NAME,
    });
  } catch {
    // A highlighter failure costs this block its colors, not the page.
    return null;
  }
  // codeToHtml wraps the lines in its own <pre><code>; keep only the lines.
  const start = html.indexOf('<code>');
  const end = html.lastIndexOf('</code>');
  return start < 0 || end < start ? null : html.slice(start + 6, end);
}

// Writes the token palette (custom property name -> value) into one document
// stylesheet rule that applies to every highlighted markdown code block, so
// the palette is resolved once per theme rather than per block, and reaches
// markdown wherever it renders.
export function installCodePalette(palette: Record<string, string>): void {
  if (typeof document === 'undefined') return;
  let element = document.getElementById(
    CODE_PALETTE_STYLE_ID
  ) as HTMLStyleElement | null;
  if (element == null) {
    element = document.createElement('style');
    element.id = CODE_PALETTE_STYLE_ID;
    document.head.append(element);
  }
  const declarations = Object.entries(palette)
    .map(([property, value]) => `${property}: ${value};`)
    .join(' ');
  element.textContent = `[${CODE_PALETTE_ATTRIBUTE}] { ${declarations} }`;
}
