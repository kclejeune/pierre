'use client';

import { IconSearch } from '@pierre/icons';

import { openCommandPalette } from './CommandPalette';
import { PaletteTrigger } from './PaletteTrigger';

// A search-input lookalike that opens the command palette, with the
// platform's launcher shortcut as a hint. A button rather than a real input
// opening on focus: Radix restores focus to the previously focused element
// when the dialog closes, so a focus-triggered open would immediately reopen.
export function CommandPaletteTrigger({ className }: { className?: string }) {
  return (
    <PaletteTrigger
      aria-label="Search repositories and pull requests"
      className={className}
      icon={<IconSearch className="size-4 shrink-0 opacity-60" />}
      shortcutKey="k"
      onClick={openCommandPalette}
    >
      Search…
    </PaletteTrigger>
  );
}
