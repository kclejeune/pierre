'use client';

import type { ReactNode } from 'react';

import { openPalette, type PaletteId } from './PaletteDialog';
import { ShortcutHint } from './ShortcutHint';
import { cn } from '@/lib/cn';

interface PaletteTriggerProps {
  'aria-label': string;
  children: ReactNode;
  className?: string;
  // Extra classes for the shortcut badge and the text label, so a cramped
  // header can drop them at narrow widths and keep just the icon.
  hintClassName?: string;
  icon: ReactNode;
  labelClassName?: string;
  // The palette this opens, and the key of its shortcut for the hint.
  paletteId: PaletteId;
  shortcutKey: string;
  // The query the palette opens on; '' opens the command palette at its top
  // level even on a page that names a repository.
  initialQuery?: string;
}

// Search-input chrome for keyboard-first palettes. It is intentionally a
// button: dialog focus restoration would immediately reopen a focus-triggered
// input after dismissal.
export function PaletteTrigger({
  'aria-label': ariaLabel,
  children,
  className,
  hintClassName,
  icon,
  initialQuery,
  labelClassName,
  paletteId,
  shortcutKey,
}: PaletteTriggerProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={cn(
        'bg-background/70 text-muted-foreground hover:border-foreground/25 inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm shadow-xs backdrop-blur-sm transition-colors',
        className
      )}
      onClick={() => openPalette(paletteId, initialQuery)}
    >
      {icon}
      <span className={cn('min-w-0 flex-1 truncate text-left', labelClassName)}>
        {children}
      </span>
      <ShortcutHint className={hintClassName} shortcutKey={shortcutKey} />
    </button>
  );
}
