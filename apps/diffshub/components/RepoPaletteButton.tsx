'use client';

import { IconChevronSm } from '@pierre/icons';

import { openCommandPalette } from './CommandPalette';
import { formatShortcut, useModifierKey } from './ShortcutHint';

// The tree view header's repository name as the way into the command
// palette: clicking it does what cmd+K does there, opening the palette on
// this repository's branches and tags, with Backspace leading out to every
// repository.
export function RepoPaletteButton({ repo }: { repo: string }) {
  const modifier = useModifierKey();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      title={`Switch branch, pull request, or repository (${formatShortcut(modifier, 'K')})`}
      className="hover:bg-accent/60 focus-visible:ring-ring flex min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 whitespace-nowrap outline-none focus-visible:ring-2"
      onClick={() => openCommandPalette()}
    >
      <span className="truncate">{repo}</span>
      <IconChevronSm className="text-muted-foreground size-3 shrink-0 rotate-90" />
    </button>
  );
}
