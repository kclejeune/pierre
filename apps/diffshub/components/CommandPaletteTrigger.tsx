'use client';

import { IconSearch } from '@pierre/icons';
import { useEffect, useState } from 'react';

import { openCommandPalette } from './CommandPalette';
import { cn } from '@/lib/cn';

// A search-input lookalike that opens the command palette, with the
// platform's launcher shortcut as a hint. A button rather than a real input
// opening on focus: Radix restores focus to the previously focused element
// when the dialog closes, so a focus-triggered open would immediately reopen.
export function CommandPaletteTrigger({ className }: { className?: string }) {
  // The shortcut hint depends on the client platform, so the server render
  // (and first client render) keep it invisible; the effect fills it in.
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    setShortcut(/mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K');
  }, []);

  return (
    <button
      type="button"
      aria-label="Search repositories and pull requests"
      className={cn(
        'bg-background text-muted-foreground hover:bg-accent/60 inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-sm transition-colors',
        className
      )}
      onClick={openCommandPalette}
    >
      <IconSearch className="size-4 shrink-0 opacity-60" />
      <span className="min-w-0 flex-1 truncate text-left">Search…</span>
      <kbd
        aria-hidden="true"
        className={cn(
          'bg-muted pointer-events-none inline-flex h-5 shrink-0 items-center rounded border px-1.5 font-mono text-[10px] font-medium',
          shortcut == null && 'opacity-0'
        )}
      >
        {shortcut ?? '⌘K'}
      </kbd>
    </button>
  );
}
