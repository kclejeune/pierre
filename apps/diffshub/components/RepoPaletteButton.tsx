'use client';

import { IconSearch } from '@pierre/icons';

import { openCommandPalette } from './CommandPalette';
import { formatShortcut, ShortcutHint, useModifierKey } from './ShortcutHint';

// The viewer headers' way into the command palette, on the left beside what
// the page shows: the tree view's repository name, or (without `repo`) a
// search button beside a pull request's address. Clicking it does what
// cmd+K does there, opening the palette inside this repository (its
// branches and tags, or its pull requests on a pull's diff), with Backspace
// leading out to every repository.
export function RepoPaletteButton({ repo }: { repo?: string }) {
  const modifier = useModifierKey();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={
        repo == null
          ? 'Search branches, pull requests, and repositories'
          : undefined
      }
      title={`Switch branch, pull request, or repository (${formatShortcut(modifier, 'K')})`}
      className="hover:bg-accent/60 focus-visible:ring-ring text-muted-foreground hover:text-foreground flex min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 whitespace-nowrap outline-none focus-visible:ring-2"
      onClick={() => openCommandPalette()}
    >
      {repo == null ? (
        <IconSearch className="size-3.5 shrink-0" />
      ) : (
        <span className="text-foreground truncate">{repo}</span>
      )}
      <ShortcutHint shortcutKey="k" />
    </button>
  );
}
