'use client';

import { IconFile } from '@pierre/icons';

import { PaletteTrigger } from './PaletteTrigger';

export function FileSearchPaletteTrigger({
  className,
  hintClassName,
  labelClassName,
}: {
  className?: string;
  hintClassName?: string;
  labelClassName?: string;
}) {
  return (
    <PaletteTrigger
      aria-label="Go to file"
      className={`h-8 px-2.5 text-xs ${className ?? ''}`}
      hintClassName={hintClassName}
      labelClassName={labelClassName}
      icon={<IconFile className="size-3.5 shrink-0 opacity-60" />}
      paletteId="file"
      shortcutKey="p"
    >
      Go to file…
    </PaletteTrigger>
  );
}
