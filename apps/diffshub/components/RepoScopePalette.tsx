'use client';

import { IconPin, IconSearch } from '@pierre/icons';
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './Command';
import { openCommandPalette } from './CommandPalette';
import { storedGitHubTokenHeaders } from './githubSession';
import { PaletteDialog } from './PaletteDialog';
import { RepoName, ScopeIcon } from './RepoName';
import { loadSuggestions } from './useDiffUrlSuggestions';
import { useRepoDirectory } from './useRepoDirectory';
import { cn } from '@/lib/cn';
import { deriveSuggestQuery } from '@/lib/diffUrlSuggestions';
import { isRepoPinned, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import { requestJSON } from '@/lib/pullCommentsClient';
import { loadRecentRepos, type PullScope } from '@/lib/pullScopes';
import {
  buildRepoScopeSections,
  MAX_REPO_MATCHES,
  type RepoScopeItem,
} from '@/lib/repoScopeItems';

// How long typing pauses before GitHub's repository search runs; local
// matches don't wait for it. Matches the URL bar's repo-suggestion delay.
const REMOTE_SEARCH_DELAY_MS = 250;
// Waits between org searches while an org listing is still being built
// (about 30s in total), after which GitHub search alone covers that org.
const ORG_RETRY_DELAYS_MS = [2000, 4000, 8000, 16_000];
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
            orgMatches: NO_REMOTE,
            recents,
            remote: NO_REMOTE,
          })
        : [],
    [directory, open, pinned, query, recents]
  );
  // The remote tiers only add repos outside the known set, so they're
  // skipped when local matches already fill the list.
  const localMatches =
    localSections.find((section) => section.heading === 'Repositories')?.items
      .length ?? 0;
  // Lowercase names the local sections can already show, which the remote
  // tiers skip.
  const knownRepos = useMemo(
    () =>
      new Set(
        [...pinned, ...recents, ...directory].map((repo) => repo.toLowerCase())
      ),
    [directory, pinned, recents]
  );
  const { orgMatches, remote } = useRemoteRepoSearch(
    open &&
      query.trim().length >= MIN_REMOTE_QUERY_LENGTH &&
      localMatches < MAX_REPO_MATCHES
      ? query
      : '',
    knownRepos
  );
  const sections = useMemo(
    () =>
      orgMatches.length === 0 && remote.length === 0
        ? localSections
        : buildRepoScopeSections({
            directory,
            orgMatches,
            pinned,
            query,
            recents,
            remote,
          }),
    [directory, localSections, orgMatches, pinned, query, recents, remote]
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

interface RemoteRepoResults {
  orgMatches: readonly string[];
  remote: readonly string[];
}

const NO_RESULTS: RemoteRepoResults = {
  orgMatches: NO_REMOTE,
  remote: NO_REMOTE,
};

// Fuzzy matches from the viewer's organizations (server-ranked over shared
// org listings, access-checked per viewer). `pending` means some org's
// listing is still being built.
async function searchOrgRepos(
  query: string,
  signal: AbortSignal
): Promise<{ pending: boolean; repos: string[] }> {
  try {
    const params = new URLSearchParams({ q: query });
    return (await requestJSON(`/api/github-org-repo-search?${params}`, {
      headers: storedGitHubTokenHeaders(),
      signal,
    })) as { pending: boolean; repos: string[] };
  } catch {
    return { pending: true, repos: [] };
  }
}

// The switcher's remote tiers for its query, debounced: org matches first,
// then GitHub's repository-name search (shared with the URL bar, and its
// browser cache) only when the orgs found nothing or are still being listed,
// since that search API allows ~30 requests a minute. Keeps the previous
// results while the next search is pending so the list doesn't flicker on
// each keystroke. Queries that can't name a repository (empty, spaces, URLs)
// show no remote rows, derived during render rather than cleared from the
// effect. While the server reports an org listing still being built, the
// org search is retried with backoff (pending responses are never cached),
// so its matches appear without retyping. GitHub search is skipped only
// when the org matches add a row: matches that are all in `knownRepos`
// (lowercase names the local sections already show) add nothing, so the
// fallback still runs.
function useRemoteRepoSearch(
  query: string,
  knownRepos: ReadonlySet<string>
): RemoteRepoResults {
  const [results, setResults] = useState<RemoteRepoResults>(NO_RESULTS);
  // Read when a search settles rather than as an effect dependency, so the
  // directory loading in doesn't restart the search.
  const known = useRef(knownRepos);
  useEffect(() => {
    known.current = knownRepos;
  }, [knownRepos]);
  // Whether the last org search said some org was still being listed; while
  // it is, GitHub search starts alongside the org search instead of after.
  const orgsPending = useRef(false);
  const suggestQuery = useMemo(() => {
    const derived = deriveSuggestQuery(query);
    return derived?.kind === 'repos' ? derived : null;
  }, [query]);
  useEffect(() => {
    if (suggestQuery == null) {
      return;
    }
    // Aborting stops a superseded org search server-side too, before its
    // access check.
    const controller = new AbortController();
    let timer = 0;
    // Re-runs only the org search; GitHub search results stay as they are.
    const retryOrgs = (attempt: number) => {
      const delay = ORG_RETRY_DELAYS_MS[attempt];
      if (delay == null) {
        return;
      }
      const retry = async () => {
        const org = await searchOrgRepos(query.trim(), controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        orgsPending.current = org.pending;
        setResults((previous) => ({ ...previous, orgMatches: org.repos }));
        if (org.pending) {
          retryOrgs(attempt + 1);
        }
      };
      timer = window.setTimeout(() => void retry(), delay);
    };
    const run = async () => {
      const early = orgsPending.current ? loadSuggestions(suggestQuery) : null;
      const org = await searchOrgRepos(query.trim(), controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      orgsPending.current = org.pending;
      setResults({ orgMatches: org.repos, remote: NO_REMOTE });
      const addsRows = org.repos.some(
        (repo) => repo !== query && !known.current.has(repo.toLowerCase())
      );
      if (org.pending) {
        retryOrgs(0);
      } else if (addsRows) {
        return;
      }
      const suggestions = await (early ?? loadSuggestions(suggestQuery));
      if (!controller.signal.aborted) {
        // Keeps org matches a retry may already have replaced.
        setResults((previous) => ({
          ...previous,
          remote: suggestions.map((suggestion) => suggestion.label),
        }));
      }
    };
    timer = window.setTimeout(() => void run(), REMOTE_SEARCH_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, suggestQuery]);
  return suggestQuery == null ? NO_RESULTS : results;
}
