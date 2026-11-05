'use client';

import {
  IconArrowRight,
  IconBolt,
  IconBookmark,
  IconBranch,
  IconClockArrow,
  IconCommit,
  IconCommitArrow,
  IconFileTree,
  IconFolder,
  IconPin,
  IconX,
} from '@pierre/icons';
import { useRouter } from 'next/navigation';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';

import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './Command';
import {
  type PaletteRunnableEntry,
  useCurrentPaletteContext,
} from './commandPaletteContext';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { focusPaletteInput, openPalette, PaletteDialog } from './PaletteDialog';
import {
  usePaletteDirectory,
  usePaletteOpenPulls,
  usePaletteRefs,
} from './paletteLists';
import { RepoName } from './RepoName';
import { formatShortcut, useModifierKey } from './ShortcutHint';
import { useGitHubToken } from './useGitHubToken';
import { useLatestValueRef } from './useLatestValueRef';
import { usePinnedRepos } from './usePinnedRepos';
import { useRemoteRepoSearch } from './useRemoteRepoSearch';
import { cn } from '@/lib/cn';
import {
  buildRepoSections,
  buildRootSections,
  COMMAND_PREFIX,
  knownRepos,
  matchKnownRepos,
  MAX_REPO_MATCHES,
  type PaletteIcon,
  type PaletteItem,
  parseRepoShorthand,
} from '@/lib/paletteItems';
import { isRepoPinned, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import {
  loadRecentDiffs,
  type RecentDiff,
  recordRecentDiff,
} from '@/lib/recentDiffs';
import { loadRecentRepos, recordRecentRepo } from '@/lib/recentRepos';

// GitHub's search API allows ~30 requests a minute per token, so single
// characters (which match nearly everything) don't spend one.
const MIN_REMOTE_QUERY_LENGTH = 2;
const NO_REPOS: readonly string[] = [];

// The repository the palette has stepped into, and which of its lists leads
// when "owner/repo#" (pull requests) or "owner/repo@" (refs) asked for one;
// null `prefer` falls back to the page's preference.
interface RepoLevel {
  repo: string;
  prefer: 'pulls' | 'refs' | null;
}

const ICONS: Record<PaletteIcon, typeof IconBranch> = {
  branch: IconCommitArrow,
  command: IconBolt,
  commit: IconCommit,
  open: IconArrowRight,
  pull: IconBranch,
  recent: IconClockArrow,
  repo: IconFolder,
  'scope-all': IconFileTree,
  'scope-pinned': IconPin,
  tag: IconBookmark,
};

// Opens the command palette, optionally on `initialQuery` (text a URL field
// couldn't open, or a trigger's preset). Without one it opens where the page
// says: inside the repository the page shows, or at the top level.
export function openCommandPalette(initialQuery?: string): void {
  openPalette('command', initialQuery);
}

// Opens the palette at its top level (every repository), even on a page that
// names one: the dashboards' "pick a repository" buttons.
export function openCommandPaletteAtTop(): void {
  openPalette('command', '');
}

// The one cmd+K / ctrl+K palette, mounted once in RootLayout (Radix portals
// the dialog to document.body, escaping the viewer grid's contain-strict
// boundary). Two levels (see lib/paletteItems): the top level finds
// repositories, recent views, pasted links, and commands; inside a
// repository it lists that repository's open pull requests, branches, and
// tags. The page on screen (useCommandPaletteContext) decides where it opens
// and what picking a repository does. Backspace on an empty query leaves the
// repository, Tab steps into a highlighted one, and cmd+Enter pins it.
export function CommandPalette() {
  const router = useRouter();
  const { host } = useGitHubEnvironment();
  const { hasToken, tokenVersion } = useGitHubToken();
  const context = useCurrentPaletteContext();
  const contextRef = useLatestValueRef(context);
  const { pinned, toggle } = usePinnedRepos();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Null at the top level.
  const [repoLevel, setRepoLevel] = useState<RepoLevel | null>(null);
  const level = repoLevel?.repo ?? null;
  // The row the user moved to, remembered with the section layout it was
  // chosen in (see `highlighted` below).
  const [highlight, setHighlight] = useState(NO_HIGHLIGHT);
  // Loaded on each open so entries recorded since the last open show up.
  const [recentDiffs, setRecentDiffs] = useState<RecentDiff[]>([]);
  const [recentRepos, setRecentRepos] = useState<readonly string[]>(NO_REPOS);

  // Moves to a level (a repository, or null for the top level) with a fresh
  // query and highlight.
  const goTo = useCallback((next: RepoLevel | null, nextQuery: string) => {
    setRepoLevel(next);
    setQuery(nextQuery);
    setHighlight(NO_HIGHLIGHT);
  }, []);
  const leaveRepo = () => goTo(null, '');
  // Steps into a repository the user picked, remembering it as recent.
  const stepInto = (repo: string) => {
    recordRecentRepo(repo);
    goTo({ repo, prefer: null }, '');
  };

  const handleOpenChange = useCallback(
    (nextOpen: boolean, initialQuery?: string) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        return;
      }
      setRecentDiffs(loadRecentDiffs());
      setRecentRepos(loadRecentRepos());
      const shorthand =
        initialQuery == null ? null : parseRepoShorthand(initialQuery);
      const pageRepo = contextRef.current?.repo;
      if (shorthand != null) {
        goTo(
          { repo: shorthand.repo, prefer: shorthand.prefer },
          shorthand.rest
        );
      } else if (initialQuery == null && pageRepo != null) {
        goTo({ repo: pageRepo, prefer: null }, '');
      } else {
        goTo(null, initialQuery ?? '');
      }
    },
    [contextRef, goTo]
  );

  // Typing or pasting "owner/repo#…" or "owner/repo@…" at the top level steps
  // into that repository with the rest as the query.
  const changeQuery = (next: string) => {
    const shorthand = level == null ? parseRepoShorthand(next) : null;
    if (shorthand != null) {
      goTo({ repo: shorthand.repo, prefer: shorthand.prefer }, shorthand.rest);
      return;
    }
    setQuery(next);
  };

  // The palette's GitHub lists load (and refresh) only while it shows them;
  // reopening answers from their cache (components/paletteLists).
  const directoryResult = usePaletteDirectory(tokenVersion, open && hasToken);
  const directory =
    directoryResult?.ok === true ? directoryResult.value : NO_REPOS;
  const known = useMemo(
    () => knownRepos(pinned, recentRepos, directory),
    [directory, pinned, recentRepos]
  );

  const isPageRepo =
    level != null &&
    context?.repo != null &&
    level.toLowerCase() === context.repo.toLowerCase();
  const commands = usePaletteCommands(
    context?.commands,
    context?.repo,
    pinned,
    toggle
  );
  const runnable = useMemo(() => {
    const byId = new Map<string, PaletteRunnableEntry>();
    for (const entry of [...(context?.scopes ?? []), ...commands]) {
      byId.set(entry.id, entry);
    }
    return byId;
  }, [commands, context?.scopes]);

  // The top level, skipped entirely while closed or inside a repository.
  // Local matches are ranked once per keystroke; remote tiers only add repos
  // outside the known set, so they're skipped when local matches already
  // fill the list.
  const atRoot = open && level == null;
  const typedQuery = atRoot ? query.trim() : '';
  const matches = useMemo(
    () =>
      typedQuery === '' || typedQuery.startsWith(COMMAND_PREFIX)
        ? NO_REPOS
        : matchKnownRepos(known, typedQuery),
    [known, typedQuery]
  );
  const { orgMatches, remote } = useRemoteRepoSearch(
    typedQuery.length >= MIN_REMOTE_QUERY_LENGTH &&
      matches.length < MAX_REPO_MATCHES
      ? typedQuery
      : '',
    known.seen,
    tokenVersion,
    hasToken
  );

  // Inside a repository: its refs and open pull requests. A failed list
  // shows as empty rather than loading.
  const shownRepo = open ? level : null;
  const refsResult = usePaletteRefs(shownRepo, tokenVersion);
  const pullsResult = usePaletteOpenPulls(shownRepo, tokenVersion);
  const refs = refsResult?.ok === true ? refsResult.value : null;
  const pulls =
    pullsResult == null ? null : pullsResult.ok ? pullsResult.value : NO_PULLS;
  const prefer = repoLevel?.prefer ?? context?.prefer ?? 'pulls';

  const sections = useMemo(() => {
    if (!open) {
      return [];
    }
    if (level != null) {
      return buildRepoSections({
        appHost: window.location.host,
        commands,
        currentPull: isPageRepo ? context?.currentPull : undefined,
        currentRef: isPageRepo ? context?.currentRef : undefined,
        githubHost: host,
        prefer,
        pulls,
        query,
        refs,
        refsFirst: repoLevel?.prefer === 'refs',
        repo: level,
      });
    }
    return buildRootSections({
      appHost: window.location.host,
      commands,
      directory,
      githubHost: host,
      known,
      matches,
      orgMatches,
      pinned,
      query,
      recentDiffs,
      recentRepos,
      remote,
      scopes: context?.scopes,
    });
  }, [
    commands,
    context?.currentPull,
    context?.currentRef,
    context?.scopes,
    directory,
    host,
    isPageRepo,
    known,
    level,
    matches,
    open,
    orgMatches,
    pinned,
    prefer,
    pulls,
    query,
    recentDiffs,
    recentRepos,
    refs,
    remote,
    repoLevel?.prefer,
  ]);
  const items = sections.flatMap((section) => section.items);
  // A choice only holds while the sections it was made in stay put: when
  // lists arrive or drop out (a repository's refs loading in above its
  // "Browse files" row, remote matches landing below local ones), the top
  // row is highlighted again, which is what Enter should pick.
  const layout = sections.map((section) => section.heading).join('\n');
  const highlighted =
    highlight.layout === layout &&
    items.some((item) => item.key === highlight.value)
      ? highlight.value
      : (items[0]?.key ?? '');

  const runItem = (item: PaletteItem) => {
    const { action } = item;
    switch (action.type) {
      case 'navigate':
        setOpen(false);
        if (level != null) {
          recordRecentRepo(level);
        }
        // Recorded here as well as by the page: the palette knows titles the
        // page doesn't (a pull's, a ref's), and patches from other domains
        // are only recorded here.
        recordRecentDiff({ path: action.path, title: action.recordTitle });
        router.push(action.path);
        return;
      case 'select-repo':
        // The page's handler records the repository itself.
        if (context?.onSelectRepo != null) {
          setOpen(false);
          context.onSelectRepo(action.repo);
        } else {
          stepInto(action.repo);
        }
        return;
      case 'run':
        setOpen(false);
        runnable.get(action.id)?.run();
        return;
    }
  };

  // Backspace on an empty query leaves the repository. Tab steps into the
  // highlighted repository. cmd/ctrl+Enter pins or unpins it without leaving
  // the palette; preventing default stops cmdk's own Enter handling, which
  // would otherwise select the item too.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Backspace' && query === '' && level != null) {
      event.preventDefault();
      leaveRepo();
      return;
    }
    const item = items.find((entry) => entry.key === highlighted);
    if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      item?.repo != null &&
      level == null
    ) {
      event.preventDefault();
      stepInto(item.repo);
      return;
    }
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      item?.repo != null
    ) {
      event.preventDefault();
      toggle(item.repo);
    }
  };

  const loading = level != null && (pullsResult == null || refsResult == null);
  // Read once here rather than per row: the hook settles in a mount effect,
  // which would re-render every row as it mounts.
  const pinShortcut = formatShortcut(useModifierKey(), '↵');

  return (
    <PaletteDialog
      open={open}
      onOpenChange={handleOpenChange}
      paletteId="command"
      shortcutKey="k"
      title="Command palette"
      description="Search repositories, pull requests, branches, and commands, or paste a link."
      commandProps={{
        onKeyDown,
        onValueChange: (value) => setHighlight({ layout, value }),
        value: highlighted,
      }}
      footer={
        <PaletteFooter
          atRoot={level == null}
          pinShortcut={pinShortcut}
          enterLabel={
            (level == null ? context?.selectRepoLabel : undefined) ?? 'Open'
          }
        />
      }
    >
      <CommandInput
        value={query}
        onValueChange={changeQuery}
        leading={
          level == null ? undefined : (
            <RepoChip repo={level} onClear={leaveRepo} />
          )
        }
        placeholder={
          level == null
            ? 'Search repositories, paste a link, or type > for commands…'
            : 'Pull requests, branches, tags, or a commit sha…'
        }
      />
      <CommandList className="max-h-[min(420px,60svh)]">
        <CommandEmpty>{loading ? 'Loading…' : 'No matches.'}</CommandEmpty>
        {sections.map((section) => (
          <CommandGroup key={section.heading} heading={section.heading}>
            {section.items.map((item) => (
              <PaletteRow
                key={item.key}
                item={item}
                pinned={item.repo != null && isRepoPinned(pinned, item.repo)}
                pinFull={pinned.length >= MAX_PINNED_REPOS}
                pinShortcut={pinShortcut}
                onSelect={() => runItem(item)}
                onTogglePin={toggle}
              />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </PaletteDialog>
  );
}

const NO_HIGHLIGHT = { layout: '', value: '' };
const NO_PULLS: readonly never[] = [];

// The page's commands plus the palette's own: the two dashboards, and
// pinning the repository the page shows.
function usePaletteCommands(
  pageCommands: readonly PaletteRunnableEntry[] | undefined,
  pageRepo: string | undefined,
  pinned: readonly string[],
  toggle: (repo: string) => void
): PaletteRunnableEntry[] {
  const router = useRouter();
  const pageRepoPinned = pageRepo != null && isRepoPinned(pinned, pageRepo);
  return useMemo(() => {
    const commands: PaletteRunnableEntry[] = [...(pageCommands ?? [])];
    if (pageRepo != null) {
      commands.push({
        id: 'toggle-page-repo-pin',
        label: pageRepoPinned ? `Unpin ${pageRepo}` : `Pin ${pageRepo}`,
        icon: 'scope-pinned',
        keywords: 'pin unpin repository',
        run: () => toggle(pageRepo),
      });
    }
    commands.push(
      {
        id: 'go-pulls',
        label: 'Your pull requests',
        detail: 'Pull request dashboard',
        icon: 'pull',
        keywords: 'dashboard pulls reviews',
        run: () => router.push('/pulls'),
      },
      {
        id: 'go-browse',
        label: 'Browse a repository',
        detail: 'Repository browser',
        icon: 'open',
        keywords: 'browse files tree branches',
        run: () => router.push('/browse'),
      }
    );
    return commands;
  }, [pageCommands, pageRepo, pageRepoPinned, router, toggle]);
}

// The repository the palette has stepped into, shown before the query.
// Clicking it, Enter or Space on it, or Backspace on an empty query goes back
// to the top level. Focus ends in the search input either way: the chip
// unmounts on leaving, and Radix's focus trap would otherwise park focus on
// the dialog, where typing does nothing.
function RepoChip({ onClear, repo }: { onClear(): void; repo: string }) {
  const leave = (chip: HTMLElement) => {
    focusPaletteInput(chip.closest('[cmdk-root]'));
    onClear();
  };
  return (
    <button
      type="button"
      title="Back to all repositories (⌫)"
      className="bg-muted hover:bg-accent flex max-w-[45%] shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5"
      onClick={(event) => leave(event.currentTarget)}
      // Handled before cmdk's root keydown, which would otherwise prevent the
      // click and select the highlighted row instead.
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          leave(event.currentTarget);
        }
      }}
    >
      <RepoName repo={repo} />
      <IconX className="text-muted-foreground size-3 shrink-0" />
    </button>
  );
}

function PaletteRow({
  item,
  onSelect,
  onTogglePin,
  pinFull,
  pinned,
  pinShortcut,
}: {
  item: PaletteItem;
  onSelect(): void;
  onTogglePin(repo: string): void;
  pinFull: boolean;
  pinned: boolean;
  pinShortcut: string;
}) {
  const { repo } = item;
  const canPin = repo != null && (pinned || !pinFull);
  const Icon = ICONS[item.icon];
  return (
    <CommandItem value={item.key} onSelect={onSelect} className="group/item">
      <Icon className="size-4" />
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
          title={`${pinned ? 'Unpin' : 'Pin'} (${pinShortcut})`}
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

function PaletteFooter({
  atRoot,
  enterLabel,
  pinShortcut,
}: {
  atRoot: boolean;
  // What Enter does: "Open", or the page's label for picking a repository.
  enterLabel: string;
  pinShortcut: string;
}) {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-[11px]">
      <FooterHint keys="↵" label={enterLabel} />
      {atRoot ? (
        <FooterHint keys="⇥" label="Pull requests and branches" />
      ) : (
        <FooterHint keys="⌫" label="All repositories" />
      )}
      <FooterHint keys={pinShortcut} label="Pin" />
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
  label: ReactNode;
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
