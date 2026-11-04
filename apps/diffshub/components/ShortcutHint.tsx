'use client';

import { useEffect, useState } from 'react';

import { type PaletteId, useOwnsShortcut } from './PaletteDialog';
import { cn } from '@/lib/cn';
import { isMacPlatform } from '@/lib/platform';

// The "⌘K" / "Ctrl K" badge on a palette's trigger. Renders nothing while
// another palette has claimed the shortcut (the /pulls repo switcher takes
// cmd+K from the diff switcher), so a hint never names a key that opens
// something else. The modifier is resolved after mount: SSR can't know the
// platform, so the badge holds its space invisibly until then.
export function ShortcutHint({
  className,
  paletteId,
  shortcutKey,
}: {
  className?: string;
  paletteId: PaletteId;
  shortcutKey: string;
}) {
  const ownsShortcut = useOwnsShortcut(shortcutKey, paletteId);
  const [modifier, setModifier] = useState<string | null>(null);
  useEffect(() => {
    setModifier(isMacPlatform() ? '⌘' : 'Ctrl');
  }, []);
  if (!ownsShortcut) {
    return null;
  }
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        'bg-muted/80 pointer-events-none inline-flex h-5 shrink-0 items-center gap-0.5 rounded border px-1.5 font-mono text-[10px] font-medium',
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
