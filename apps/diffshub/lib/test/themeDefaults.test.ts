import { themes } from '@pierre/theming/themes';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import {
  BUILTIN_THEME_DEFAULTS,
  readThemeDefaults,
} from '../theme/themeDefaults';

const MANAGED = ['DIFFSHUB_DEFAULT_LIGHT_THEME', 'DIFFSHUB_DEFAULT_DARK_THEME'];
const ORIGINAL_ENV = new Map(
  MANAGED.map((key) => [key, process.env[key]] as const)
);

describe('readThemeDefaults', () => {
  beforeEach(() => {
    for (const key of MANAGED) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED) {
      const value = ORIGINAL_ENV.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test('uses the built-in pair when unset', () => {
    expect(readThemeDefaults(themes)).toEqual(BUILTIN_THEME_DEFAULTS);
  });

  test('built-in defaults exist in the catalog with the right scheme', () => {
    expect(themes.getTheme(BUILTIN_THEME_DEFAULTS.light)?.colorScheme).toBe(
      'light'
    );
    expect(themes.getTheme(BUILTIN_THEME_DEFAULTS.dark)?.colorScheme).toBe(
      'dark'
    );
  });

  test('honors configured names', () => {
    process.env.DIFFSHUB_DEFAULT_LIGHT_THEME = ' pierre-light-soft ';
    process.env.DIFFSHUB_DEFAULT_DARK_THEME = 'pierre-dark-soft';
    expect(readThemeDefaults(themes)).toEqual({
      light: 'pierre-light-soft',
      dark: 'pierre-dark-soft',
    });
  });

  test('falls back on unknown or wrong-scheme names', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DIFFSHUB_DEFAULT_LIGHT_THEME = 'pierre-dark-soft';
    process.env.DIFFSHUB_DEFAULT_DARK_THEME = 'no-such-theme';
    expect(readThemeDefaults(themes)).toEqual(BUILTIN_THEME_DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
