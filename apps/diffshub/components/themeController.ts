import { createThemeController, type ThemePersistence } from '@pierre/theming';

import { docsThemeCatalog } from './themeCatalog';
import {
  onPreferencesRestored,
  readSyncedItem,
  writeSyncedItem,
} from '@/lib/preferenceSync';
import {
  applyThemeBootstrapStyle,
  buildThemeBootstrapStyle,
  persistThemeBootstrapSnapshot,
} from '@/lib/theme/themeBootstrap';

export { docsThemeCatalog } from './themeCatalog';

// The single owner of the diffshub app's theming state. Color mode (light/
// dark/system), the light/dark theme-name picks, and their persistence all
// live here, so there is no parallel state ownership. The controller creates
// and owns the resolver; consumers that need an explicit resolver use the
// docsThemeResolver alias below rather than creating a second cache.
//
// It is a module singleton: created once per process on the server (where the
// browser guards make it a constant) and once per page-load on the client,
// surviving client-side navigations.

// Maps the controller's selection onto three synced preferences
// (lib/preferenceSync), which keeps them under the legacy localStorage keys
// the pre-paint no-flash bootstrap script reads: mode as a plain
// `light`/`dark`/`system` string under `theme`, and the theme names under the
// diffshub-prefixed keys.
// TODO(theming): migrate off these legacy keys and use
// createThemeController's built-in `storageKey` persistence shape instead.
const docsPersistence: ThemePersistence = {
  load() {
    const mode = readSyncedItem('colorMode');
    const light = readSyncedItem('lightTheme');
    const dark = readSyncedItem('darkTheme');
    if (mode == null && light == null && dark == null) return null;
    const validMode =
      mode === 'light' || mode === 'dark' || mode === 'system'
        ? mode
        : 'system';
    return {
      mode: validMode,
      lightThemeName: light ?? docsThemeCatalog.defaultLightThemeName,
      darkThemeName: dark ?? docsThemeCatalog.defaultDarkThemeName,
    };
  },
  save(selection) {
    writeSyncedItem('colorMode', selection.mode);
    writeSyncedItem('lightTheme', selection.lightThemeName);
    writeSyncedItem('darkTheme', selection.darkThemeName);
  },
};

export const themeController = createThemeController({
  catalog: docsThemeCatalog,
  persistence: docsPersistence,
  defaultMode: 'system',
});

let lastBootstrapTheme: object | undefined;
let lastBootstrapSelection: string | undefined;
function syncThemeBootstrap(): void {
  const state = themeController.getState();
  const theme = state.resolvedTheme;
  const colorScheme = state.resolvedColorScheme;
  const themeName =
    colorScheme === 'dark' ? state.darkThemeName : state.lightThemeName;
  const selection = `${colorScheme}:${themeName}`;
  if (
    theme == null ||
    (theme === lastBootstrapTheme && selection === lastBootstrapSelection)
  ) {
    return;
  }
  lastBootstrapTheme = theme;
  lastBootstrapSelection = selection;

  const style = buildThemeBootstrapStyle(theme);
  applyThemeBootstrapStyle(style);
  persistThemeBootstrapSnapshot(colorScheme, {
    style,
    themeName,
  });
}

syncThemeBootstrap();
themeController.subscribe(syncThemeBootstrap);

// A selection restored from the server after sign-in lands in localStorage
// after the controller loaded; apply it as one change, without saving it back.
if (typeof window !== 'undefined') {
  onPreferencesRestored(['colorMode', 'darkTheme', 'lightTheme'], () => {
    themeController.reloadFromPersistence();
  });
}

export const docsThemeResolver = themeController.resolver;
