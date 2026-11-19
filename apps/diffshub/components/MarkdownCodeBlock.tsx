'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';

import { useDiffThemeProps } from './useDiffThemeProps';
import { useHighlightTheme } from './useHighlightTheme';
import {
  getLoadedHighlights,
  loadHighlights,
  tokenizeFence,
  tokenStyle,
} from '@/lib/markdownCodeHighlight';

interface MarkdownCodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  language: string;
  source: string;
}

// A fenced code block in rendered markdown, syntax highlighted with
// @pierre/highlights in the active diff theme. Renders the plain source until
// the highlighter has loaded (and permanently for unsupported languages), so
// the block's text and layout are the same either way. The theme's token
// palette is applied on the <pre> itself because markdown also renders
// outside the diff views that otherwise provide it (pull descriptions, the
// browse blob view).
export function MarkdownCodeBlock({
  language,
  source,
  style,
  ...rest
}: MarkdownCodeBlockProps) {
  const [highlights, setHighlights] = useState(getLoadedHighlights);
  useEffect(() => {
    if (highlights != null) return;
    let cancelled = false;
    void loadHighlights().then((module) => {
      if (!cancelled && module != null) setHighlights(module);
    });
    return () => {
      cancelled = true;
    };
  }, [highlights]);
  const lines = useMemo(
    () =>
      highlights == null ? null : tokenizeFence(highlights, source, language),
    [highlights, source, language]
  );
  const palette = useHighlightTheme(useDiffThemeProps().theme).style;
  return (
    <pre {...rest} style={lines == null ? style : { ...palette, ...style }}>
      <code className={`language-${language}`}>
        {lines == null
          ? source
          : lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && '\n'}
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={tokenStyle(token)}>
                    {token.content}
                  </span>
                ))}
              </Fragment>
            ))}
      </code>
    </pre>
  );
}
