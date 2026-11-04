'use client';

import { IconPin, IconSearch } from '@pierre/icons';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';

import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './Command';
import { openCommandPalette } from './CommandPalette';
import { PaletteDialog } from './PaletteDialog';
import { RepoName, ScopeIcon } from './RepoName';
import { loadSuggestions } from './useDiffUrlSuggestions';
import { useRepoDirectory } from './useRepoDirectory';
import { cn } from '@/lib/cn';
import { deriveSuggestQuery } from '@/lib/diffUrlSuggestions';
import { isRepoPinned, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import { loadRecentRepos, type PullScope } from '@/lib/pullScopes';
import {
  buildRepoScopeSections,
  MAX_REPO_MATCHES,
  type RepoScopeItem,
} from '@/lib/repoScopeItems';

// How long typing pauses before GitHub's repository search runs; local
// matches don't wait for it. Matches the URL bar's repo-suggestion delay.
const REMOTE_SEARCH_DELAY_MS = 250;
// GitHub's search API allows ~30 requests a minute per token, shared with
// the URL bar, so single characters (which match nearly everything) don't
// spend one.
const MIN_REMOTE_QUERY_LENGTH = 2;
// Stable empty results, so the sections memo isn't invalidated by a fresh
// [] on renders without remote rows.
const NO_REMOTE: readonly string[] = [];

interface RepoScopePaletteProps {
  onOpenChange(open: boolean): void;
  onSelectScope(scope: PullScope): void;
  onTogglePin(repo: string): void;
  open: boolean;
  pinned: readonly string[];
  tokenVersion: number;
}

// The /pulls page's cmd+K: a repository switcher that scopes the list. It
// claims cmd+K from the global diff switcher while the page is mounted (see
// PaletteDialog) and hands anything that isn't a repository back to it.
// Mounted with the page rather than on open, so the directory listing is
// already loaded by the first keystroke.
export function RepoScopePalette({
  onOpenChange,
  onSelectScope,
  onTogglePin,
  open,
  pinned,
  tokenVersion,
}: RepoScopePaletteProps) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const { groups } = useRepoDirectory(tokenVersion);
  const directory = useMemo(
    () =>
      groups
        .flatMap((group) => group.repos)
        .filter((repo) => !repo.archived)
        .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
        .map((repo) => repo.fullName),
    [groups]
  );

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (nextOpen) {
      setQuery('');
      setRecents(loadRecentRepos());
    }
  };

  // Local sections first, skipped entirely while closed (the query lingers
  // after a pick, and the page re-renders the switcher on every scope or chip
  // change).
  const localSections = useMemo(
    () =>
      open
        ? buildRepoScopeSections({
            directory,
            pinned,
            query,
            recents,
            remote: NO_REMOTE,
          })
        : [],
    [directory, open, pinned, query, recents]
  );
  // GitHub's search only adds repos outside the known set, so it's skipped
  // when local matches already fill the list.
  const localMatches =
    localSections.find((section) => section.heading === 'Repositories')?.items
      .length ?? 0;
  const remote = useRemoteRepoSearch(
    open &&
      query.trim().length >= MIN_REMOTE_QUERY_LENGTH &&
      localMatches < MAX_REPO_MATCHES
      ? query
      : ''
  );
  const sections = useMemo(
    () =>
      remote.length === 0
        ? localSections
        : buildRepoScopeSections({ directory, pinned, query, recents, remote }),
    [directory, localSections, pinned, query, recents, remote]
  );
  const items = sections.flatMap((section) => section.items);

  const runItem = (item: RepoScopeItem) => {
    onOpenChange(false);
    if (item.action.type === 'search-everywhere') {
      openCommandPalette(query);
      return;
    }
    onSelectScope(item.action.scope);
  };

  // cmd/ctrl+Enter pins or unpins the highlighted repository without leaving
  // the switcher. Preventing default stops cmdk's own Enter handling, which
  // would otherwise select the item too.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) {
      return;
    }
    const item = items.find((entry) => entry.key === highlighted);
    if (item?.repo != null) {
      event.preventDefault();
      onTogglePin(item.repo);
    }
  };

  return (
    <PaletteDialog
      open={open}
      onOpenChange={handleOpenChange}
      paletteId="repo-scope"
      shortcutKey="k"
      title="Switch repository"
      description="Choose which repositories' pull requests to list."
      commandProps={{
        onKeyDown,
        onValueChange: setHighlighted,
        value: highlighted,
      }}
      footer={<PaletteFooter />}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Jump to a repository…"
      />
      <CommandList className="max-h-[min(420px,60svh)]">
        <CommandEmpty>No repositories match.</CommandEmpty>
        {sections.map((section) => (
          <CommandGroup key={section.heading} heading={section.heading}>
            {section.items.map((item) => (
              <ScopeItem
                key={item.key}
                item={item}
                pinned={item.repo != null && isRepoPinned(pinned, item.repo)}
                pinFull={pinned.length >= MAX_PINNED_REPOS}
                onSelect={() => runItem(item)}
                onTogglePin={onTogglePin}
              />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </PaletteDialog>
  );
}

function ScopeItem({
  item,
  onSelect,
  onTogglePin,
  pinFull,
  pinned,
}: {
  item: RepoScopeItem;
  onSelect(): void;
  onTogglePin(repo: string): void;
  pinFull: boolean;
  pinned: boolean;
}) {
  const { repo } = item;
  const canPin = repo != null && (pinned || !pinFull);
  return (
    <CommandItem value={item.key} onSelect={onSelect} className="group/item">
      {item.action.type === 'search-everywhere' ? (
        <IconSearch className="size-4" />
      ) : (
        <ScopeIcon className="size-4" scope={item.action.scope} />
      )}
      {repo != null ? (
        <RepoName repo={repo} />
      ) : (
        <span className="truncate">{item.label}</span>
      )}
      {item.detail != null && (
        <span className="text-muted-foreground ml-auto shrink-0 truncate pl-3 text-xs">
          {item.detail}
        </span>
      )}
      {canPin && (
        <button
          type="button"
          aria-label={pinned ? `Unpin ${repo}` : `Pin ${repo}`}
          aria-pressed={pinned}
          title={pinned ? 'Unpin (⌘↵)' : 'Pin (⌘↵)'}
          className={cn(
            'hover:bg-background/80 -my-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm',
            item.detail == null && 'ml-auto',
            pinned
              ? 'text-foreground'
              : 'opacity-0 group-hover/item:opacity-100 group-data-[selected=true]/item:opacity-100 focus-visible:opacity-100'
          )}
          // Keeps cmdk from treating the click as selecting the row.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(repo);
          }}
        >
          <IconPin
            className={cn('size-3.5', pinned && 'text-foreground')}
            aria-hidden
          />
        </button>
      )}
    </CommandItem>
  );
}

function PaletteFooter() {
  return (
    <div className="text-muted-foreground flex items-center gap-4 border-t px-3 py-2 text-[11px]">
      <FooterHint keys="↵" label="View pull requests" />
      <FooterHint keys="⌘↵" label="Pin or unpin" />
      <FooterHint keys="esc" label="Close" className="ml-auto" />
    </div>
  );
}

function FooterHint({
  className,
  keys,
  label,
}: {
  className?: string;
  keys: string;
  label: string;
}) {
  return (
    <span className={cn('flex items-center gap-1.5', className)}>
      <kbd className="bg-muted rounded border px-1 font-mono text-[10px]">
        {keys}
      </kbd>
      {label}
    </span>
  );
}

// GitHub's repository-name search for the switcher's query, debounced, as
// plain "owner/name" strings. Shares the URL bar's suggestion endpoint (and
// its browser cache). Keeps the previous results while the next search is
// pending so the list doesn't flicker on each keystroke. Queries that can't
// name a repository (empty, spaces, URLs) show no remote rows, derived during
// render rather than cleared from the effect.
function useRemoteRepoSearch(query: string): readonly string[] {
  const [results, setResults] = useState<readonly string[]>(NO_REMOTE);
  const suggestQuery = useMemo(() => {
    const derived = deriveSuggestQuery(query);
    return derived?.kind === 'repos' ? derived : null;
  }, [query]);
  useEffect(() => {
    if (suggestQuery == null) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadSuggestions(suggestQuery).then((suggestions) => {
        if (!cancelled) {
          setResults(suggestions.map((suggestion) => suggestion.label));
        }
      });
    }, REMOTE_SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [suggestQuery]);
  return suggestQuery == null ? NO_REMOTE : results;
}
