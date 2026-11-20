'use client';

import type { ComponentProps } from 'react';

import { DialogContent } from './Dialog';
import { useChromeThemeProps } from './useChromeThemeProps';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';

// A DialogContent on the chrome theme. Dialogs portal outside the themed
// page, so without this they paint the stock page white or black around
// themed code (quick look, the conflict resolver). Applies the chrome style
// (canvas background and the color tokens) to the dialog itself; must render
// under the ThemeSourceProvider whose theme it should follow.
export function ThemedDialogContent({
  style,
  ...props
}: ComponentProps<typeof DialogContent>) {
  const { style: chromeStyle } = useChromeThemeProps(diffshubChromeMapping);
  return <DialogContent style={{ ...chromeStyle, ...style }} {...props} />;
}
