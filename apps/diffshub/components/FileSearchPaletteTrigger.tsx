'use client';

import { IconFile } from '@pierre/icons';

import { openPalette } from './PaletteDialog';
import { PaletteTrigger } from './PaletteTrigger';

export function FileSearchPaletteTrigger({
  className,
}: {
  className?: string;
}) {
  return (
    <PaletteTrigger
      aria-label="Go to file"
      className={`h-8 px-2.5 text-xs ${className ?? ''}`}
      icon={<IconFile className="size-3.5 shrink-0 opacity-60" />}
      shortcutKey="p"
      onClick={() => openPalette('file')}
    >
      Go to file…
    </PaletteTrigger>
  );
}
