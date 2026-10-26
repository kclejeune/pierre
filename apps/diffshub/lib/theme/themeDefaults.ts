import type { ColorScheme, ThemeCollection } from '@pierre/theming';

import { readNonEmptyString } from '@/lib/githubOAuthGrant';

export type ThemeDefaults = Record<ColorScheme, string>;

export const BUILTIN_THEME_DEFAULTS: ThemeDefaults = {
  light: 'catppuccin-latte',
  dark: 'one-dark-pro',
};

declare global {
  interface Window {
    // Written by the root layout's head script before any client component
    // module runs, so the browser sees the same defaults the server rendered
    // with.
    __DIFFSHUB_THEME_DEFAULTS__?: ThemeDefaults;
  }
}

// Picks `configured` when it names a theme of `colorScheme` in `themes`;
// otherwise warns and falls back to the built-in default. A typo in the env
// var should degrade to the built-in default, not crash every page.
function validThemeName(
  themes: ThemeCollection,
  colorScheme: ColorScheme,
  configured: unknown
): string {
  const fallback = BUILTIN_THEME_DEFAULTS[colorScheme];
  const name = readNonEmptyString(configured);
  if (name == null) return fallback;
  if (themes.getTheme(name)?.colorScheme === colorScheme) return name;
  console.warn(
    `[diffshub] Ignoring default ${colorScheme} theme "${name}": not a ${colorScheme} theme in the catalog; using "${fallback}".`
  );
  return fallback;
}

// Resolves the default light/dark theme names from DIFFSHUB_DEFAULT_LIGHT_THEME
// and DIFFSHUB_DEFAULT_DARK_THEME. On the server these are read once per
// process from the runtime environment; in the browser they come from the
// window global the head script sets, since DIFFSHUB_* values are never
// inlined into the client bundle.
export function readThemeDefaults(themes: ThemeCollection): ThemeDefaults {
  const configured: Partial<ThemeDefaults> =
    typeof window === 'undefined'
      ? {
          light: process.env.DIFFSHUB_DEFAULT_LIGHT_THEME,
          dark: process.env.DIFFSHUB_DEFAULT_DARK_THEME,
        }
      : (window.__DIFFSHUB_THEME_DEFAULTS__ ?? {});
  return {
    light: validThemeName(themes, 'light', configured.light),
    dark: validThemeName(themes, 'dark', configured.dark),
  };
}
