import darkSoftTheme from '@pierre/theme/pierre-dark-soft';
import lightSoftTheme from '@pierre/theme/pierre-light-soft';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildThemeBootstrapStyle } from '../theme/themeBootstrap';

// app/globals.css hand-copies the chrome style of the default soft themes so
// the first frame, painted before the theme module loads, already matches the
// live theme. This test keeps those copies in step with deriveChromeTokens:
// when it fails, paste the generated values into the named block.
const GLOBALS_CSS = readFileSync(
  join(import.meta.dir, '..', '..', 'app', 'globals.css'),
  'utf8'
);

// The light block names its brightened canvas once as a variable and
// reuses it; the generated style spells the mix out in full.
const LIGHT_CANVAS_MIX = 'color-mix(in srgb, white 35%, #f7f7f7)';

// Reads the custom properties and background of one bootstrap block.
function readBootstrapBlock(mode: 'dark' | 'light'): Record<string, string> {
  const header = `:where(.${mode}) .diffshub-theme-bootstrap.diffshub-theme-bootstrap {`;
  const start = GLOBALS_CSS.indexOf(header);
  if (start === -1) {
    throw new Error(`No ${mode} bootstrap block in app/globals.css`);
  }
  const end = GLOBALS_CSS.indexOf('\n}', start);
  const body = GLOBALS_CSS.slice(start + header.length, end).replaceAll(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
  const declarations: Record<string, string> = {};
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    declarations[declaration.slice(0, colon).trim()] = declaration
      .slice(colon + 1)
      .trim();
  }
  return declarations;
}

// Puts a value in one comparable form: single spaces, no padding inside
// parentheses (the formatter wraps long mixes), and shadow alphas as
// decimals (the formatter rewrites `/ 0.09` as `/ 9%`).
function normalize(value: string, canvas?: string): string {
  let text = value;
  if (canvas != null) {
    text = text.replaceAll('var(--diffshub-bootstrap-canvas)', canvas);
  }
  return text
    .replaceAll(/\s+/g, ' ')
    .replaceAll('( ', '(')
    .replaceAll(' )', ')')
    .replaceAll(/\/ (\d+(?:\.\d+)?)%/g, (_, percent: string) => {
      return `/ ${Number(percent) / 100}`;
    })
    .trim();
}

describe('app/globals.css theme bootstrap', () => {
  test.each([
    ['light', lightSoftTheme, LIGHT_CANVAS_MIX],
    ['dark', darkSoftTheme, undefined],
  ] as const)(
    'the %s block matches the derived chrome style',
    (mode, theme, canvas) => {
      const css = readBootstrapBlock(mode);
      const expected: Record<string, string> = {};
      const actual: Record<string, string> = {};
      for (const [property, value] of Object.entries(
        buildThemeBootstrapStyle(theme)
      )) {
        expected[property] = normalize(value);
        actual[property] = normalize(css[property] ?? '(missing)', canvas);
      }
      expect(actual).toEqual(expected);
    }
  );
});
