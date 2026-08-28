'use client';

import { IconFile } from '@pierre/icons';
import { useEffect, useMemo, useState } from 'react';

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from './Command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './Dialog';
import { filterFilePathsForSearch } from '@/lib/fileSearchFilter';

interface FileSearchPaletteProps {
  // Every file path the current view can jump to (the browse tree's listing,
  // or the diff's changed files).
  paths: readonly string[];
  onSelectPath(path: string): void;
}

// The go-to-file palette for views that hold a file listing (repo browser,
// diff viewer): cmd+P / ctrl+P — cmd+K stays the global diff switcher —
// fuzzy-filters the listing and selecting a file jumps to it in place.
// Mounted only by those views, so the shortcut does nothing elsewhere.
export function FileSearchPalette({
  paths,
  onSelectPath,
}: FileSearchPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === 'p'
      ) {
        // Also swallows the browser's print dialog while a file view is open.
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
    }
  }, [open]);

  const matches = useMemo(
    () => filterFilePathsForSearch(paths, query),
    [paths, query]
  );

  const runSelect = (path: string) => {
    setOpen(false);
    onSelectPath(path);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[20%] translate-y-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Go to file</DialogTitle>
          <DialogDescription>
            Search the files in this view and jump to one.
          </DialogDescription>
        </DialogHeader>
        {/* Ranking lives in filterFilePathsForSearch (basename-aware fuzzy
            tiers), so cmdk's own filter stays off. */}
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Go to file…"
          />
          <CommandList>
            <CommandEmpty>No matching files.</CommandEmpty>
            {matches.map((path) => {
              const separator = path.lastIndexOf('/');
              const basename = path.slice(separator + 1);
              const directory = separator < 0 ? null : path.slice(0, separator);
              return (
                <CommandItem
                  key={path}
                  value={path}
                  onSelect={() => runSelect(path)}
                >
                  <IconFile className="size-4" />
                  <span className="truncate">{basename}</span>
                  {directory != null && (
                    <span className="text-muted-foreground ml-auto truncate font-mono text-xs">
                      {directory}
                    </span>
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
