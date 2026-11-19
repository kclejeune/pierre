'use client';

import { startTransition, useEffect, useMemo, useState } from 'react';

import { themeController } from './themeController';
import {
  CODE_PALETTE_ATTRIBUTE,
  getLoadedHighlighter,
  highlightFence,
  installCodePalette,
  loadHighlighter,
} from '@/lib/markdownCodeHighlight';
import { highlightPalette } from '@/lib/theme/highlightTheme';

interface MarkdownCodeBlockProps extends Omit<
  React.HTMLAttributes<HTMLPreElement>,
  'children'
> {
  language: string;
  source: string;
}

let paletteSubscribed = false;
let paletteKey = '';

// Keeps the code palette stylesheet rule on the app's current light/dark
// theme pair. Reads the theme controller directly rather than a
// ThemeSourceProvider so markdown gets colors on every page, including ones
// that mount no provider (the /pulls dashboard). Called by each highlighted
// block on mount, so pages without code fences never resolve the palette,
// and a failed resolve is retried by the next block instead of sticking.
function syncPalette(): void {
  if (!paletteSubscribed) {
    paletteSubscribed = true;
    themeController.subscribe(syncPalette);
  }
  const { lightThemeName, darkThemeName } = themeController.getState();
  const key = `${lightThemeName}\0${darkThemeName}`;
  if (key === paletteKey) return;
  paletteKey = key;
  highlightPalette(lightThemeName, darkThemeName).then(
    (palette) => {
      // A newer selection may have landed while this one resolved.
      if (key === paletteKey) installCodePalette(palette);
    },
    (error: unknown) => {
      console.error('Failed to load markdown code palette', error);
      if (key === paletteKey) paletteKey = '';
    }
  );
}

// A fenced code block in rendered markdown, syntax highlighted with
// @pierre/highlights through the page's shared highlighter. Renders the plain
// source until the highlighter has loaded (and permanently without
// WebAssembly or past the size cap), so the block's text and layout are the
// same either way. Highlighting after the first load runs as a
// transition, so a page full of fenced comments doesn't block input.
export function MarkdownCodeBlock({
  language,
  source,
  ...rest
}: MarkdownCodeBlockProps) {
  const [highlighter, setHighlighter] = useState(getLoadedHighlighter);
  useEffect(() => {
    if (highlighter != null) return;
    void loadHighlighter().then((loaded) => {
      if (loaded != null) startTransition(() => setHighlighter(loaded));
    });
  }, [highlighter]);
  const html = useMemo(
    () =>
      highlighter == null
        ? null
        : highlightFence(highlighter, source, language),
    [highlighter, source, language]
  );
  useEffect(() => {
    if (html != null) syncPalette();
  }, [html]);
  const languageClass = `language-${language}`;
  if (html == null) {
    return (
      <pre {...rest}>
        <code className={languageClass}>{source}</code>
      </pre>
    );
  }
  return (
    <pre {...rest} {...{ [CODE_PALETTE_ATTRIBUTE]: '' }}>
      <code
        className={languageClass}
        // highlightFence returns highlighter-escaped token markup.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}
