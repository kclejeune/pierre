'use client';

import { IconPin, IconPlus } from '@pierre/icons';
import type { ReactNode } from 'react';

import {
  SELECTED_SEGMENT_CLASS,
  UNSELECTED_CHIP_CLASS,
} from '@/components/ButtonGroup';
import { cn } from '@/lib/cn';
import { isRepoPinned, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import { splitPath } from '@/lib/splitPath';

// Pins as bookmarks: one-click chips for the repositories you return to,
// shared by /pulls (where they scope the list) and /browse (where they open
// a repository's refs). A repository opened from the palette but not pinned
// shows as a dashed chip at the end, with its pin button, so pinning is
// something you do to what you're looking at. `leading` chips (the /pulls
// broad scopes) come first. `vertical` stacks the chips full-width for a side
// rail instead of wrapping them in a row.
export function RepoPinStrip({
  addPinLabel = 'Pin repositories you check often',
  ariaLabel,
  leading,
  onAddPin,
  onSelectRepo,
  onTogglePin,
  orientation = 'horizontal',
  pinned,
  selectedRepo,
}: {
  addPinLabel?: string;
  ariaLabel: string;
  leading?: ReactNode;
  orientation?: 'horizontal' | 'vertical';
  onAddPin(): void;
  onSelectRepo(repo: string): void;
  onTogglePin(repo: string): void;
  pinned: readonly string[];
  // The repository on screen, or null.
  selectedRepo: string | null;
}) {
  const selectedIsPinned =
    selectedRepo != null && isRepoPinned(pinned, selectedRepo);
  // Repo names alone, unless two pins share one.
  const names = pinned.map((repo) => splitPath(repo).basename);
  const ambiguous = new Set(
    names.filter((name, index) => names.indexOf(name) !== index)
  );
  const vertical = orientation === 'vertical';
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        'flex gap-1',
        vertical ? 'flex-col items-stretch gap-0.5' : 'flex-wrap items-center'
      )}
    >
      {leading}
      {pinned.map((repo, index) => {
        const selected =
          selectedRepo != null &&
          repo.toLowerCase() === selectedRepo.toLowerCase();
        return (
          <ScopeChip
            key={repo}
            fill={vertical}
            mono
            selected={selected}
            title={repo}
            onClick={() => onSelectRepo(repo)}
            trailing={
              selected ? (
                <PinToggle pinned repo={repo} onToggle={onTogglePin} />
              ) : undefined
            }
          >
            {ambiguous.has(names[index]) ? repo : names[index]}
          </ScopeChip>
        );
      })}
      {selectedRepo != null && !selectedIsPinned && (
        <ScopeChip
          fill={vertical}
          mono
          selected
          dashed
          title={`${selectedRepo} (not pinned)`}
          // Its full owner/repo name is the longest label in the strip, so
          // on a phone it spans the row (pin at the far end), and wider it
          // gets a 20rem cap rather than the inline chips' 14rem, room for a
          // typical owner/repo before it truncates.
          growOnPhone
          trailing={
            pinned.length < MAX_PINNED_REPOS ? (
              <PinToggle
                pinned={false}
                repo={selectedRepo}
                onToggle={onTogglePin}
              />
            ) : undefined
          }
        >
          {selectedRepo}
        </ScopeChip>
      )}
      {pinned.length === 0 && selectedRepo == null && (
        <button
          type="button"
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring flex cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2',
            vertical ? 'h-7 px-2 text-left' : 'h-6 pointer-coarse:h-8'
          )}
          onClick={onAddPin}
        >
          <IconPlus className="size-3" />
          {addPinLabel}
        </button>
      )}
    </nav>
  );
}

// A chip in the strip. Without `onClick` it's a static label (the dashed
// chip for the current, unpinned repo, which is already selected). `fill`
// makes it a full-width rail row instead of an inline chip.
export function ScopeChip({
  children,
  dashed = false,
  fill = false,
  growOnPhone = false,
  mono = false,
  onClick,
  selected,
  title,
  trailing,
}: {
  children: ReactNode;
  dashed?: boolean;
  fill?: boolean;
  growOnPhone?: boolean;
  mono?: boolean;
  onClick?(): void;
  selected: boolean;
  title?: string;
  trailing?: ReactNode;
}) {
  const labelClassName = cn(
    'flex h-full items-center gap-1 rounded-[inherit] px-2',
    fill ? 'min-w-0 flex-1' : 'max-w-56',
    growOnPhone &&
      !fill &&
      'max-sm:min-w-0 max-sm:max-w-none max-sm:flex-1 sm:max-w-80',
    mono && 'font-mono text-[12px]',
    trailing != null && 'pr-1'
  );
  const label = (
    <span className="flex min-w-0 items-center gap-1 truncate">{children}</span>
  );
  return (
    <span
      className={cn(
        'flex items-center rounded-md border text-xs transition-colors',
        // Inline chips grow to 32px on touch screens, where 24px is too
        // small a tap; the strip wraps, so nothing else has to move.
        fill ? 'h-7' : 'h-6 pointer-coarse:h-8',
        growOnPhone && !fill && 'max-sm:w-full max-sm:min-w-0',
        // Inline chips lift like a segmented control; rail rows fill like a
        // nav list, so a selected row doesn't read as a text field.
        selected
          ? fill
            ? 'bg-accent text-foreground border-transparent font-medium'
            : SELECTED_SEGMENT_CLASS
          : UNSELECTED_CHIP_CLASS,
        dashed && 'border-dashed'
      )}
    >
      {onClick == null ? (
        <span className={labelClassName} title={title}>
          {label}
        </span>
      ) : (
        <button
          type="button"
          aria-current={selected ? 'page' : undefined}
          className={cn(
            labelClassName,
            'focus-visible:ring-ring cursor-pointer outline-none focus-visible:ring-2'
          )}
          title={title}
          onClick={onClick}
        >
          {label}
        </button>
      )}
      {trailing}
    </span>
  );
}

export function PinToggle({
  onToggle,
  pinned,
  repo,
}: {
  onToggle(repo: string): void;
  pinned: boolean;
  repo: string;
}) {
  return (
    <button
      type="button"
      aria-label={pinned ? `Unpin ${repo}` : `Pin ${repo}`}
      aria-pressed={pinned}
      title={pinned ? 'Unpin' : 'Pin'}
      className={cn(
        'hover:bg-accent focus-visible:ring-ring mr-0.5 flex size-5 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2 pointer-coarse:size-7',
        pinned ? 'text-foreground' : 'text-muted-foreground'
      )}
      onClick={() => onToggle(repo)}
    >
      <IconPin className="size-3" />
    </button>
  );
}
