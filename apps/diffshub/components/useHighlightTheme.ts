'use client';

import { canUseWASM, type ThemesType } from '@pierre/diffs';
import { type CSSProperties, useEffect, useState } from 'react';

import { HIGHLIGHT_THEMES, highlightPalette } from '@/lib/theme/highlightTheme';

export function useHighlightTheme(theme: ThemesType): {
  theme: ThemesType;
  style: CSSProperties | undefined;
} {
  // Only highlights renders the css-variables theme; the shiki-js fallback
  // pool used without WebAssembly keeps the real theme pair.
  const enabled = canUseWASM();
  const [style, setStyle] = useState<CSSProperties>();
  const { light, dark } = theme;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    highlightPalette(light, dark).then(
      (palette) => {
        if (!cancelled) setStyle(palette);
      },
      (error: unknown) => {
        console.error('Failed to load highlight palette', error);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, light, dark]);
  return {
    theme: enabled ? HIGHLIGHT_THEMES : theme,
    style: enabled ? style : undefined,
  };
}
