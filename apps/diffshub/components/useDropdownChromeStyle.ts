'use client';

import { type CSSProperties, useMemo } from 'react';

import { useChromeThemeProps } from './useChromeThemeProps';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';
import { getDropdownThemeStyle } from '@/lib/theme/dropdownChromeStyle';

// The style a portaled DropdownMenuContent needs to stay on the chrome theme
// (the wrapper's CSS variables don't reach the portal): resolves the chrome
// theme, treats the pre-resolution empty style as "not ready", and memoizes
// the popover overrides. One hook instead of the same three-step block in
// every dropdown-bearing chrome component.
export function useDropdownChromeStyle(): CSSProperties | undefined {
  const { style: chromeStyle } = useChromeThemeProps(diffshubChromeMapping);
  return useMemo(
    () =>
      getDropdownThemeStyle(
        Object.keys(chromeStyle).length > 0 ? chromeStyle : undefined
      ),
    [chromeStyle]
  );
}
