'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/lib/cn';
import { isMacPlatform } from '@/lib/platform';

// The platform's shortcut modifier, '⌘' or 'Ctrl', or null before mount:
// SSR can't know the platform, so it's resolved in an effect.
export function useModifierKey(): '⌘' | 'Ctrl' | null {
  const [modifier, setModifier] = useState<'⌘' | 'Ctrl' | null>(null);
  useEffect(() => {
    setModifier(isMacPlatform() ? '⌘' : 'Ctrl');
  }, []);
  return modifier;
}

// A shortcut for prose and titles: "⌘K" on macOS, "Ctrl+K" elsewhere
// (and "⌘K" until the platform is known).
export function formatShortcut(
  modifier: '⌘' | 'Ctrl' | null,
  key: string
): string {
  return modifier === 'Ctrl' ? `Ctrl+${key}` : `⌘${key}`;
}

// The "⌘K" / "Ctrl K" badge on a palette's trigger. The modifier is
// resolved after mount: SSR can't know the platform, so the badge holds its
// space invisibly until then. Hidden on touch-first devices (coarse
// pointer), where there is usually no keyboard to press it with; containers
// short on room can hide it too by targeting data-shortcut-hint.
export function ShortcutHint({
  className,
  shortcutKey,
}: {
  className?: string;
  shortcutKey: string;
}) {
  const modifier = useModifierKey();
  return (
    <kbd
      aria-hidden="true"
      data-shortcut-hint
      className={cn(
        'bg-muted/80 pointer-events-none inline-flex pointer-coarse:hidden h-5 shrink-0 items-center gap-0.5 rounded border px-1.5 font-mono text-[10px] font-medium',
        modifier == null && 'opacity-0',
        className
      )}
    >
      <span className={cn((modifier ?? '⌘') === '⌘' && 'text-xs')}>
        {modifier ?? '⌘'}
      </span>
      {shortcutKey.toUpperCase()}
    </kbd>
  );
}
