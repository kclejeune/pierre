'use client';

import { IconArrowRightShort, IconBranch } from '@pierre/icons';
import { type CSSProperties, type ReactNode, useRef, useState } from 'react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './Command';
import { useGitHubToken } from './useGitHubToken';
import { type RepoRefsState, useRepoRefs } from './useRepoRefs';
import {
  DropdownMenu,
  DropdownMenuContent,
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
  // The muted heading above the branch list ("Switch base to…").
  heading: string;
  // Refs already occupying a side of the comparison, hidden from the list —
  // picking one would build a degenerate or no-op compare.
  excludeRefs: readonly string[];
  getRefHref(ref: string): string;
}

// The picker body shared by every ref menu: the load states, then the
// repository's branches, each row linking to the view getRefHref builds.
// The rows are cmdk items, so RefPillMenu's filter input narrows them
// (fuzzy, via cmdk's default scorer) and sorts the best match first.
export function RefPickerItems({
  refsState,
  heading,
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
    <>
      <CommandGroup heading={heading}>
        {branches.map((branch) => (
          <RefPickerRow key={branch} value={branch}>
            <a href={getRefHref(branch)}>
              <span className="truncate font-mono text-[12px]">{branch}</span>
            </a>
          </RefPickerRow>
        ))}
      </CommandGroup>
      <CommandEmpty>No matching branches.</CommandEmpty>
    </>
  );
}

function RefPickerNote({ children }: { children: string }) {
  return (
    <p className="text-muted-foreground px-2 py-1.5 text-sm">{children}</p>
  );
}

// A fixed action row above the branch list ("Browse files at this ref",
// "Commit diff…"), pinned visible whatever the filter text says. cmdk skips
// registering force-mounted items, so pinned rows never count as filter
// matches and sink below scored branches once a query is typed.
export function RefPickerAction({ children }: { children: ReactNode }) {
  return <RefPickerRow pinned>{children}</RefPickerRow>;
}

// One selectable picker row. The row's single anchor/Link child does the
// real navigation, so modified clicks (new tab) and Next.js client links
// keep their native behavior: pointer selection defers to the anchor click
// already in flight (detected in the capture phase, since cmdk overwrites
// onClick), while keyboard selection follows the link by clicking it.
function RefPickerRow({
  pinned = false,
  value,
  children,
}: {
  pinned?: boolean;
  value?: string;
  children: ReactNode;
}) {
  const itemRef = useRef<HTMLDivElement | null>(null);
  const anchorClickInFlight = useRef(false);
  return (
    <CommandItem
      ref={itemRef}
      value={value}
      forceMount={pinned || undefined}
      className="p-0 [&_a]:flex [&_a]:min-w-0 [&_a]:flex-1 [&_a]:items-center [&_a]:gap-2 [&_a]:px-2 [&_a]:py-1.5"
      onClickCapture={() => {
        anchorClickInFlight.current = true;
      }}
      onSelect={() => {
        const fromClick = anchorClickInFlight.current;
        anchorClickInFlight.current = false;
        if (fromClick) {
          return;
        }
        itemRef.current?.querySelector('a')?.click();
      }}
    >
      {children}
    </CommandItem>
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
  // The menu content: optional RefPickerActions, then RefPickerItems.
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
        className="w-64 p-0"
        style={dropdownThemeStyle}
      >
        <Command
          label={title}
          // Keys the picker handles (typing, arrows, Enter) must not bubble
          // to the Radix menu, whose typeahead/activation would steal them;
          // Escape and Tab still bubble so the menu closes normally.
          onKeyDown={(event) => {
            if (event.key !== 'Escape' && event.key !== 'Tab') {
              event.stopPropagation();
            }
          }}
        >
          <CommandInput placeholder="Filter branches…" autoFocus />
          <CommandList>{children}</CommandList>
        </Command>
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
