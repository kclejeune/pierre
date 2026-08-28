'use client';

import {
  IconArrowRight,
  IconBranch,
  IconClockArrow,
  IconFolder,
} from '@pierre/icons';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './Command';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { PaletteDialog } from './PaletteDialog';
import { useDiffUrlSuggestions } from './useDiffUrlSuggestions';
import { usePinnedRepos } from './usePinnedRepos';
import { buildPaletteItems, type PaletteItem } from '@/lib/commandPaletteItems';
import { loadRecentDiffs, recordRecentDiff } from '@/lib/recentDiffs';

const ITEM_ICONS: Record<PaletteItem['kind'], typeof IconBranch> = {
  action: IconArrowRight,
  open: IconArrowRight,
  pull: IconBranch,
  recent: IconClockArrow,
  repo: IconFolder,
};

// Fired by UI affordances (e.g. the home page's search bar) to open the
// palette without a keyboard shortcut; the mounted palette listens globally.
export const OPEN_COMMAND_PALETTE_EVENT = 'diffshub:open-command-palette';

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}

// Global cmd+K / ctrl+K switcher: recent diffs and pinned repos when idle,
// the URL bar's progressive repo → pull-request search once the user types,
// and a direct "Go to" entry for anything that already resolves to a viewer
// path. Mounted once in RootLayout; Radix portals the dialog to
// document.body, escaping the viewer grid's contain-strict boundary.
export function CommandPalette() {
  const router = useRouter();
  const { host } = useGitHubEnvironment();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The URL bar's debounced progressive repo → pull search, sharing its
  // request cache; '' (closed palette) disables it.
  const suggestions = useDiffUrlSuggestions(open ? query : '');
  const { pinned } = usePinnedRepos();
  // Loaded on each open so entries recorded since the last open show up.
  const [recents, setRecents] = useState<ReturnType<typeof loadRecentDiffs>>(
    []
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setQuery('');
      setRecents(loadRecentDiffs());
    }
  }, []);

  useEffect(() => {
    const onOpenRequest = () => handleOpenChange(true);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    return () =>
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
  }, [handleOpenChange]);

  const sections = useMemo(
    () =>
      buildPaletteItems({
        githubHost: host,
        pinned,
        query,
        recents,
        suggestions,
      }),
    [host, pinned, query, recents, suggestions]
  );

  const runItem = (item: PaletteItem) => {
    if (item.action.type === 'fill') {
      setQuery(item.action.value);
      return;
    }
    recordRecentDiff({
      path: item.action.path,
      title: item.action.recordTitle,
    });
    setOpen(false);
    router.push(item.action.path);
  };

  return (
    <PaletteDialog
      open={open}
      onOpenChange={handleOpenChange}
      shortcutKey="k"
      title="Diff switcher"
      description="Search repositories and pull requests, or jump to a recent diff."
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search repos, pull requests, or paste a URL…"
      />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {sections.map((section) => (
          <CommandGroup key={section.heading} heading={section.heading}>
            {section.items.map((item) => {
              const Icon = ITEM_ICONS[item.kind];
              return (
                <CommandItem
                  key={item.key}
                  value={item.key}
                  onSelect={() => runItem(item)}
                >
                  <Icon className="size-4" />
                  <span className="truncate">{item.label}</span>
                  {item.detail != null && (
                    <span className="text-muted-foreground ml-auto truncate text-xs">
                      {item.detail}
                    </span>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </PaletteDialog>
  );
}
