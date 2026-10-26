import { createThemeCatalog } from '@pierre/theming';
import { themes } from '@pierre/theming/themes';

import { readThemeDefaults } from '@/lib/theme/themeDefaults';

export const themeDefaults = readThemeDefaults(themes);

export const docsThemeCatalog = createThemeCatalog({
  themes,
  defaultLightThemeName: themeDefaults.light,
  defaultDarkThemeName: themeDefaults.dark,
});
