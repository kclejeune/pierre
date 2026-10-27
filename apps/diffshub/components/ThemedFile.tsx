'use client';

import { File, type FileProps } from '@pierre/diffs/react';
import { useMemo } from 'react';

import { useDiffThemeProps } from './useDiffThemeProps';
import { useHighlightTheme } from './useHighlightTheme';
import { useWorkerDiffTheme } from './useWorkerDiffTheme';
import { getPreferredHighlighter } from '@/lib/preferredHighlighter';
import type { DiffThemeInput } from '@/lib/theme/diffThemeProps';

interface ThemedFileProps<
  LAnnotation = undefined,
  Caret = undefined,
> extends FileProps<LAnnotation, Caret> {
  // Names-now override (omitted => follow the provider/source).
  theme?: DiffThemeInput;
}

// Sugar over useDiffThemeProps for the React <File>, matching ThemedCodeView:
// renders with the highlights css-variables theme (palette applied through
// the style), and keeps the shared worker pool on that same theme pair.
export function ThemedFile<LAnnotation = undefined, Caret = undefined>({
  options,
  style,
  theme,
  ...props
}: ThemedFileProps<LAnnotation, Caret>) {
  const diffTheme = useDiffThemeProps(theme);
  const highlightTheme = useHighlightTheme(diffTheme.theme);
  useWorkerDiffTheme(highlightTheme.theme);
  const themedOptions = useMemo(
    () => ({
      ...options,
      preferredHighlighter: getPreferredHighlighter(),
      theme: highlightTheme.theme,
      themeType: options?.themeType ?? diffTheme.themeType,
    }),
    [highlightTheme.theme, diffTheme.themeType, options]
  );
  return (
    <File<LAnnotation, Caret>
      {...props}
      options={themedOptions}
      style={{ ...highlightTheme.style, ...style }}
    />
  );
}
