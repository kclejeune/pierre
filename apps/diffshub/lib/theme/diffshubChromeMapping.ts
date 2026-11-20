// Stays app-local. The diffshub-specific mapping from ChromeTokens
// (lib/theme/deriveChromeTokens, which computes every surface, card, and
// inline thread color) to the app's CSS variables: the --diffshub-*,
// --color-*, and --foreground vocabulary the components read.
import type { ThemeLike } from '@pierre/theming';
import { normalizeThemeColors } from '@pierre/theming/color';
import type { CSSProperties } from 'react';

import type { ChromeTokens } from './deriveChromeTokens';

// A ChromeMapping turns the neutral chrome tokens (or undefined when the theme
// has no legible foreground) plus the source theme into a host CSS style. The
// theme is passed so a mapping can tell whether the theme has a sidebar
// background to paint at all.
export type ChromeMapping = (
  chrome: ChromeTokens | undefined,
  theme: ThemeLike
) => CSSProperties | undefined;

export const diffshubChromeMapping: ChromeMapping = (chrome, theme) => {
  // The resolved theme's sidebar background, read from the shared
  // normalizeThemeColors derivation (the same key trees and deriveChromeTokens
  // read). Without one the chrome paints no background of its own.
  const sidebarBg = normalizeThemeColors(theme).colors?.['sideBar.background'];
  const bg =
    typeof sidebarBg === 'string' && sidebarBg !== '' ? sidebarBg : undefined;

  // No chrome means deriveChromeTokens found no legible foreground (degenerate
  // bg-only theme). Mirror the previous behavior: paint just the background when
  // we have one, otherwise contribute nothing.
  // `--diffshub-sidebar-surface` republishes the painted background for
  // sticky surfaces inside the chrome (the overview panel's merge footer)
  // that must hide what scrolls under them.
  if (chrome == null) {
    return bg != null
      ? ({
          backgroundColor: bg,
          '--diffshub-sidebar-surface': bg,
        } as CSSProperties)
      : undefined;
  }

  const fg = chrome.fg;
  // The painted background: the chrome's canvas (the sidebar, brightened on
  // light themes; see deriveChromeTokens).
  const canvas = bg == null ? undefined : chrome.background;
  const style: CSSProperties & Record<string, string> = {};
  if (canvas != null) {
    style.backgroundColor = canvas;
    style['--diffshub-sidebar-surface'] = canvas;
  }
  style.color = fg;
  style['--color-foreground'] = fg;
  style['--foreground'] = fg;
  style['--color-muted-foreground'] = chrome.mutedFg;
  style['--muted-foreground'] = chrome.mutedFg;
  style['--color-border'] = chrome.border;
  style['--border'] = chrome.border;
  style['--color-border-opaque'] = chrome.borderOpaque;
  style['--border-opaque'] = chrome.borderOpaque;
  // The sidebar's comment cards and segmented controls (see their
  // ChromeTokens for how they differ on light and dark themes).
  style['--diffshub-card-bg'] = chrome.cardBg;
  style['--diffshub-card-hover-bg'] = chrome.cardHoverBg;
  style['--diffshub-card-border'] = chrome.cardBorder;
  style['--diffshub-segment-selected-bg'] = chrome.segmentSelectedBg;
  style['--diffshub-popover-bg'] = chrome.surface;
  style['--diffshub-popover-fg'] = fg;
  style['--diffshub-popover-muted-fg'] = chrome.mutedFg;
  style['--diffshub-popover-hover-bg'] = chrome.surfaceHover;
  style['--diffshub-popover-selected-bg'] = chrome.surfaceSelected;
  style['--diffshub-popover-border'] = chrome.surfaceBorder;
  style['--diffshub-popover-shadow'] = chrome.surfaceShadow;
  style['--diffshub-annotation-bg'] = chrome.annotationBg;
  style['--diffshub-annotation-fg'] = fg;
  style['--diffshub-annotation-border'] = chrome.annotationBorder;
  style['--diffshub-annotation-hover-border'] = chrome.annotationHoverBorder;
  style['--diffshub-annotation-inset-bg'] = chrome.annotationInsetBg;
  style['--diffshub-annotation-muted-fg'] = chrome.annotationMutedFg;
  style['--diffshub-annotation-strong-fg'] = chrome.annotationStrongFg;
  style['--diffshub-annotation-shadow'] = chrome.surfaceShadow;
  style['--color-popover'] = chrome.surface;
  style['--popover'] = chrome.surface;
  style['--color-popover-foreground'] = fg;
  style['--popover-foreground'] = fg;
  style['--color-card'] = chrome.surface;
  style['--card'] = chrome.surface;
  style['--color-card-foreground'] = fg;
  style['--card-foreground'] = fg;
  style['--color-background'] = chrome.background;
  style['--background'] = chrome.background;
  style['--color-accent'] = chrome.surfaceHover;
  style['--accent'] = chrome.surfaceHover;
  style['--color-accent-foreground'] = fg;
  style['--accent-foreground'] = fg;
  // `secondary` is the segmented-control (ButtonGroup) track. It must sit
  // visibly behind the buttons so the Auto/Light/Dark options read as one
  // connected control, so it reuses the slightly stronger hover mix.
  style['--color-secondary'] = chrome.surfaceHover;
  style['--secondary'] = chrome.surfaceHover;
  style['--color-secondary-foreground'] = fg;
  style['--secondary-foreground'] = fg;
  style['--color-input'] = chrome.surfaceHover;
  style['--input'] = chrome.surfaceHover;
  style['--color-muted'] = chrome.surfaceHover;
  style['--muted'] = chrome.surfaceHover;
  style['--color-primary'] = fg;
  style['--primary'] = fg;
  style['--color-primary-foreground'] = chrome.background;
  style['--primary-foreground'] = chrome.background;
  style['--color-ring'] = chrome.ring;
  style['--ring'] = chrome.ring;
  style['--diffshub-comment-add-fg'] = chrome.additionFg;
  style['--diffshub-comment-del-fg'] = chrome.deletionFg;
  style['--diffshub-diff-separator'] = chrome.separator;
  if (chrome.editorBg != null) {
    style['--diffshub-editor-bg'] = chrome.editorBg;
  }
  if (chrome.scrollbarThumb != null) {
    style['--diffshub-scrollbar-thumb-bg'] = chrome.scrollbarThumb;
  }
  if (chrome.scrollbarTrack != null) {
    style['--diffshub-scrollbar-track-bg'] = chrome.scrollbarTrack;
  }
  return style;
};
