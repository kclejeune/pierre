'use client';

import { IconChevronSm, IconCodeSearch, IconX } from '@pierre/icons';
import { type KeyboardEvent, useEffect, useRef } from 'react';

import {
  DiffSearchInput,
  SearchIconButton,
  useActiveMatch,
  useDiffSearchResults,
} from './DiffSearchInput';
import type { DiffSearchController } from './useDiffSearchController';
import { cn } from '@/lib/cn';
import type { DiffSearchQuery } from '@/lib/diffSearch';
import { isMacPlatform } from '@/lib/platform';

export interface DiffFindRequest {
  // Bumped on every Ctrl+F so a repeat press re-scopes and refocuses.
  id: number;
  itemId: string | null;
}

interface DiffFindBarProps {
  className?: string;
  controller: DiffSearchController;
  onClose(): void;
  // Hands the current query to the cross-file search panel.
  onSearchAll(query: DiffSearchQuery): void;
  query: DiffSearchQuery;
  request: DiffFindRequest;
  setQuery(query: DiffSearchQuery): void;
}

// The Ctrl+F find widget: searches the file at the top of the viewport,
// highlights every match in it, and steps through them with Enter /
// Shift+Enter (or Cmd/Ctrl+G and Shift+Cmd/Ctrl+G). The query outlives the
// bar so reopening resumes the last search, as in editors.
export function DiffFindBar({
  className,
  controller,
  onClose,
  onSearchAll,
  query,
  request,
  setQuery,
}: DiffFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { itemId } = request;
  const results = useDiffSearchResults(
    controller,
    query,
    itemId == null ? null : { itemId }
  );
  const { matches } = results;
  const { navigateTo, showMatches, clearMatches } = controller;
  const { activeIndex, activeMatch, select, step } = useActiveMatch(
    matches,
    navigateTo
  );
  const path = itemId == null ? null : controller.getSource(itemId)?.path;

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, [request.id]);

  // A new result set (the query or scope changed) jumps to its first match;
  // a refresh that still contains the active match leaves the view alone.
  useEffect(() => {
    if (results.settled && activeIndex === -1) {
      select(matches[0] ?? null);
    }
  }, [activeIndex, matches, results.settled, select]);

  useEffect(() => {
    showMatches('find', matches, activeMatch);
  }, [activeMatch, matches, showMatches]);
  useEffect(() => () => clearMatches('find'), [clearMatches]);

  // Cmd/Ctrl+G steps matches from anywhere while the bar is open, replacing
  // the browser's own find-next.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'g'
      ) {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [step]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  const countLabel =
    query.text === ''
      ? null
      : results.error != null
        ? 'Invalid'
        : matches.length === 0
          ? 'No results'
          : `${Math.max(activeIndex, 0) + 1} of ${matches.length}${results.truncated ? '+' : ''}`;

  return (
    <div
      role="search"
      aria-label="Find in file"
      className={cn(
        'bg-background flex w-[min(440px,calc(100%-2rem))] flex-col gap-1 rounded-lg border border-[var(--color-border-opaque)] p-1.5 shadow-lg',
        className
      )}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <DiffSearchInput
        inputRef={inputRef}
        invalid={results.error != null}
        placeholder="Find in file"
        query={query}
        onChange={setQuery}
        onKeyDown={handleKeyDown}
        trailing={
          <>
            {countLabel != null && (
              <span
                aria-live="polite"
                className={cn(
                  'text-muted-foreground shrink-0 px-1 text-[11px] whitespace-nowrap tabular-nums',
                  results.error != null && 'text-destructive'
                )}
                title={results.error ?? undefined}
              >
                {countLabel}
              </span>
            )}
            <SearchIconButton
              label="Previous match (Shift+Enter)"
              disabled={matches.length === 0}
              onClick={() => step(-1)}
            >
              <IconChevronSm className="size-3.5 rotate-180" />
            </SearchIconButton>
            <SearchIconButton
              label="Next match (Enter)"
              disabled={matches.length === 0}
              onClick={() => step(1)}
            >
              <IconChevronSm className="size-3.5" />
            </SearchIconButton>
            <SearchIconButton label="Close (Escape)" onClick={onClose}>
              <IconX className="size-3.5" />
            </SearchIconButton>
          </>
        }
      />
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 px-1 text-[11px]">
        <span className="min-w-0 truncate" title={path ?? undefined}>
          {path == null ? 'No file in view' : `In ${path}`}
        </span>
        <button
          type="button"
          className="hover:text-foreground focus-visible:text-foreground ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1 outline-none"
          title="Search all files in the diff"
          onClick={() => onSearchAll(query)}
        >
          <IconCodeSearch className="size-3" />
          All files
          <kbd className="font-sans opacity-70">
            {isMacPlatform() ? '⇧⌘F' : 'Ctrl+Shift+F'}
          </kbd>
        </button>
      </div>
    </div>
  );
}
