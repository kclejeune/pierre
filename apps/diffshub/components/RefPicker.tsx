'use client';

import { IconArrowRightShort, IconBranch } from '@pierre/icons';
import { type CSSProperties, type ReactNode, useState } from 'react';

import { useGitHubToken } from './useGitHubToken';
import { type RepoRefsState, useRepoRefs } from './useRepoRefs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/DropdownMenu';
import { cn } from '@/lib/cn';
import type { GitHubRepo } from '@/lib/githubDiffSource';

// Shared machinery for the base/head ref pills shown in the diff and browse
// headers. Branches load lazily on first open so views that never open a
// picker pay nothing; a load that failed retries the next time the menu
// opens. The listing authenticates with the stored GitHub token, read here so
// callers don't thread it through their prop chains.
export function useLazyRepoRefs(repo: GitHubRepo): {
  handleOpenChange(open: boolean): void;
  refsState: RepoRefsState;
} {
  const { hydrated, token } = useGitHubToken();
  const [opened, setOpened] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  // Hold the fetch until the stored token hydrates, so a menu opened in the
  // first frames doesn't fire anonymously and refire when the token lands.
  const refsState = useRepoRefs(
    repo,
    token === '' ? undefined : token,
    opened && hydrated,
    reloadToken
  );
  const handleOpenChange = (open: boolean) => {
    if (open) {
      setOpened(true);
      if (refsState.kind === 'error') {
        setReloadToken((current) => current + 1);
      }
    }
  };
  return { handleOpenChange, refsState };
}

interface RefPickerItemsProps {
  refsState: RepoRefsState;
  // Refs already occupying a side of the comparison, hidden from the list —
  // picking one would build a degenerate or no-op compare.
  excludeRefs: readonly string[];
  getRefHref(ref: string): string;
}

// The dropdown body shared by every ref picker: the load states, then the
// repository's branches, each row linking to the view getRefHref builds.
export function RefPickerItems({
  refsState,
  excludeRefs,
  getRefHref,
}: RefPickerItemsProps) {
  if (refsState.kind === 'idle' || refsState.kind === 'loading') {
    return <RefPickerNote>Loading branches…</RefPickerNote>;
  }
  if (refsState.kind === 'error') {
    return <RefPickerNote>Loading branches failed.</RefPickerNote>;
  }
  const branches = refsState.data.branches.filter(
    (branch) => !excludeRefs.includes(branch)
  );
  if (branches.length === 0) {
    return <RefPickerNote>No other branches.</RefPickerNote>;
  }
  return (
    <div className="max-h-72 overflow-y-auto">
      {branches.map((branch) => (
        <DropdownMenuItem key={branch} asChild>
          <a href={getRefHref(branch)}>
            <span className="truncate font-mono text-[12px]">{branch}</span>
          </a>
        </DropdownMenuItem>
      ))}
    </div>
  );
}

function RefPickerNote({ children }: { children: string }) {
  return (
    <p className="text-muted-foreground px-2 py-1.5 text-sm">{children}</p>
  );
}

// The muted heading above a picker's branch list ("Switch base to…").
export function RefPickerLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenuLabel className="text-muted-foreground text-xs">
      {children}
    </DropdownMenuLabel>
  );
}

const PILL_CLASS =
  'inline-flex h-6 min-w-0 max-w-[32ch] items-center gap-1.5 rounded-md border border-[var(--diffshub-card-border,var(--color-border))] bg-[var(--diffshub-card-bg,var(--color-muted))] px-1.5 hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))] hover:text-foreground focus-visible:ring-ring cursor-pointer outline-none focus-visible:ring-2';

interface RefPillMenuProps {
  kind: 'base' | 'head';
  label: string;
  // A pill that names no concrete ref yet (a compare base still to be
  // chosen); renders its label muted.
  placeholder?: boolean;
  ariaLabel: string;
  title: string;
  dropdownThemeStyle?: CSSProperties;
  onOpenChange(open: boolean): void;
  // The menu content: leading items, a RefPickerLabel, RefPickerItems.
  children: ReactNode;
}

// One base/head pill: a labeled trigger opening a dropdown the caller fills.
// The same element serves the diff header (swap a side of the comparison) and
// the browse header (pick a compare base, switch the browsed ref).
export function RefPillMenu({
  kind,
  label,
  placeholder = false,
  ariaLabel,
  title,
  dropdownThemeStyle,
  onOpenChange,
  children,
}: RefPillMenuProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        aria-label={ariaLabel}
        title={title}
        className={PILL_CLASS}
      >
        <span
          aria-hidden="true"
          className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-[10px] font-medium tracking-wide uppercase"
        >
          <IconBranch className="size-3" />
          {kind}
        </span>
        <span
          className={cn(
            'truncate font-mono text-[11px]',
            placeholder && 'text-muted-foreground'
          )}
        >
          {label}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64"
        style={dropdownThemeStyle}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The arrow between the pills, pointing at the base — the direction changes
// flow ("merge <head> into <base>").
export function RefPillArrow() {
  return (
    // The icon set has no left-pointing short arrow; mirror the right one.
    <IconArrowRightShort
      aria-hidden="true"
      className="text-muted-foreground size-3 shrink-0 -scale-x-100"
    />
  );
}
