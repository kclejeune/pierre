'use client';

import { IconPin, IconPlus } from '@pierre/icons';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { isRepoPinned, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import { splitPath } from '@/lib/splitPath';

// Pins as bookmarks: one-click chips for the repositories you return to,
// shared by /pulls (where they scope the list) and /browse (where they open
// a repository's refs). A repository opened from the palette but not pinned
// shows as a dashed chip at the end, with its pin button, so pinning is
// something you do to what you're looking at. `leading` chips (the /pulls
// broad scopes) come first.
export function RepoPinStrip({
  addPinLabel = 'Pin repositories you check often',
  ariaLabel,
  leading,
  onAddPin,
  onSelectRepo,
  onTogglePin,
  pinned,
  selectedRepo,
}: {
  addPinLabel?: string;
  ariaLabel: string;
  leading?: ReactNode;
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
  return (
    <nav aria-label={ariaLabel} className="flex flex-wrap items-center gap-1">
      {leading}
      {pinned.map((repo, index) => {
        const selected =
          selectedRepo != null &&
          repo.toLowerCase() === selectedRepo.toLowerCase();
        return (
          <ScopeChip
            key={repo}
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
          mono
          selected
          dashed
          title={`${selectedRepo} (not pinned)`}
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
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2"
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
// chip for the current, unpinned repo, which is already selected).
export function ScopeChip({
  children,
  dashed = false,
  mono = false,
  onClick,
  selected,
  title,
  trailing,
}: {
  children: ReactNode;
  dashed?: boolean;
  mono?: boolean;
  onClick?(): void;
  selected: boolean;
  title?: string;
  trailing?: ReactNode;
}) {
  const labelClassName = cn(
    'flex h-full max-w-56 items-center gap-1 rounded-[inherit] px-2',
    mono && 'font-mono text-[12px]',
    trailing != null && 'pr-1'
  );
  const label = (
    <span className="flex min-w-0 items-center gap-1 truncate">{children}</span>
  );
  return (
    <span
      className={cn(
        'flex h-6 items-center rounded-md border text-xs transition-colors',
        selected
          ? 'bg-background text-foreground shadow-xs'
          : 'text-muted-foreground hover:text-foreground border-transparent',
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
        'hover:bg-accent focus-visible:ring-ring mr-0.5 flex size-5 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2',
        pinned ? 'text-foreground' : 'text-muted-foreground'
      )}
      onClick={() => onToggle(repo)}
    >
      <IconPin className="size-3" />
    </button>
  );
}
