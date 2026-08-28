'use client';

import { type ReactNode, useEffect, useState } from 'react';

import { cn } from '@/lib/cn';

interface PaletteTriggerProps {
  'aria-label': string;
  children: ReactNode;
  className?: string;
  icon: ReactNode;
  onClick(): void;
  shortcutKey: string;
}

// Search-input chrome for keyboard-first palettes. It is intentionally a
// button: dialog focus restoration would immediately reopen a focus-triggered
// input after dismissal.
export function PaletteTrigger({
  'aria-label': ariaLabel,
  children,
  className,
  icon,
  onClick,
  shortcutKey,
}: PaletteTriggerProps) {
  const [modifier, setModifier] = useState<string | null>(null);
  useEffect(() => {
    setModifier(/mac/i.test(navigator.platform) ? '⌘' : 'Ctrl');
  }, []);

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={cn(
        'bg-background/70 text-muted-foreground hover:border-foreground/25 inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm shadow-xs backdrop-blur-sm transition-colors',
        className
      )}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <kbd
        aria-hidden="true"
        className={cn(
          'bg-muted/80 pointer-events-none inline-flex h-5 shrink-0 items-center gap-0.5 rounded border px-1.5 font-mono text-[10px] font-medium',
          modifier == null && 'opacity-0'
        )}
      >
        <span className={cn((modifier ?? '⌘') === '⌘' && 'text-xs')}>
          {modifier ?? '⌘'}
        </span>
        {shortcutKey.toUpperCase()}
      </kbd>
    </button>
  );
}
