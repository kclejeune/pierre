'use client';

import { useStableCallback } from '@pierre/diffs/react';
import { IconRegex, IconTypeWord } from '@pierre/icons';
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useDeferredValue,
  useMemo,
  useState,
} from 'react';

import type { DiffSearchController } from './useDiffSearchController';
import { cn } from '@/lib/cn';
import {
  compileDiffSearchQuery,
  type DiffSearchMatch,
  type DiffSearchQuery,
  type DiffSearchResult,
  getDiffSearchMatchKey,
  searchDiffSources,
} from '@/lib/diffSearch';

export const EMPTY_DIFF_SEARCH_QUERY: DiffSearchQuery = {
  text: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

interface DiffSearchResultsState extends DiffSearchResult {
  error: string | null;
  // False while the deferred query lags the typed one.
  settled: boolean;
}

const NO_RESULTS = { matches: [], truncated: false, error: null };

// What a result list searches: every loaded file, one item, or nothing
// (hidden panel, no file in view).
export type DiffSearchScope = 'all' | { itemId: string } | null;

// Runs a query over the scope. The query is deferred so typing stays
// responsive on large diffs, and the search re-runs when the controller's
// sources change (files streaming in, full files landing).
export function useDiffSearchResults(
  controller: DiffSearchController,
  query: DiffSearchQuery,
  scope: DiffSearchScope
): DiffSearchResultsState {
  const deferredQuery = useDeferredValue(query);
  const { getSource, getSources } = controller;
  const itemId = scope == null || scope === 'all' ? null : scope.itemId;
  const enabled = scope != null;
  const result = useMemo(() => {
    if (!enabled) {
      return NO_RESULTS;
    }
    const compiled = compileDiffSearchQuery(deferredQuery);
    if (compiled.type === 'empty') {
      return NO_RESULTS;
    }
    if (compiled.type === 'error') {
      return { ...NO_RESULTS, error: compiled.message };
    }
    const source = itemId == null ? null : getSource(itemId);
    const sources =
      itemId == null ? getSources() : source == null ? [] : [source];
    return {
      ...searchDiffSources(sources, compiled.pattern),
      error: null,
    };
  }, [deferredQuery, enabled, getSource, getSources, itemId]);
  return { ...result, settled: deferredQuery === query };
}

// The highlighted ("current") match in a result list and stepping through
// it. The active match is tracked by key so it survives re-searches that
// still contain it; `activeIndex` is -1 when it is gone (or never set).
export function useActiveMatch(
  matches: readonly DiffSearchMatch[],
  navigateTo: (match: DiffSearchMatch) => void
) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const indexByKey = useMemo(
    () =>
      new Map(
        matches.map((match, index) => [getDiffSearchMatchKey(match), index])
      ),
    [matches]
  );
  const activeIndex =
    activeKey == null ? -1 : (indexByKey.get(activeKey) ?? -1);
  const select = useStableCallback((match: DiffSearchMatch | null) => {
    setActiveKey(match == null ? null : getDiffSearchMatchKey(match));
    if (match != null) {
      navigateTo(match);
    }
  });
  // Moves by `delta` with wraparound; with nothing active, forward starts at
  // the first match and backward at the last.
  const step = useStableCallback((delta: 1 | -1) => {
    if (matches.length === 0) {
      return;
    }
    const from = activeIndex === -1 ? (delta === 1 ? -1 : 0) : activeIndex;
    select(matches[(from + delta + matches.length) % matches.length] ?? null);
  });
  return {
    activeIndex,
    activeMatch: matches[activeIndex] ?? null,
    select,
    step,
  };
}

interface DiffSearchInputProps {
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  onChange(query: DiffSearchQuery): void;
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
  placeholder: string;
  query: DiffSearchQuery;
  // Rendered after the toggles inside the field (match counts, nav buttons).
  trailing?: ReactNode;
  invalid?: boolean;
}

const TOGGLE_KEYS = {
  KeyC: 'caseSensitive',
  KeyW: 'wholeWord',
  KeyR: 'regex',
} as const;

// The query field with VS Code's three toggles: match case (Alt+C), whole
// word (Alt+W), and regular expression (Alt+R).
export function DiffSearchInput({
  className,
  inputRef,
  invalid = false,
  onChange,
  onKeyDown,
  placeholder,
  query,
  trailing,
}: DiffSearchInputProps) {
  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex') =>
    onChange({ ...query, [key]: !query[key] });
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // event.code, since Option+letter produces a symbol on macOS.
    const key =
      event.altKey && !event.metaKey && !event.ctrlKey
        ? TOGGLE_KEYS[event.code as keyof typeof TOGGLE_KEYS]
        : undefined;
    if (key != null) {
      event.preventDefault();
      toggle(key);
      return;
    }
    onKeyDown?.(event);
  };
  return (
    <div
      className={cn(
        'border-input focus-within:border-ring focus-within:ring-ring/50 flex h-8 min-w-0 items-center gap-0.5 rounded-md border bg-transparent pr-1 shadow-xs focus-within:ring-[3px] dark:bg-input/30',
        invalid && 'border-destructive',
        className
      )}
    >
      <input
        ref={inputRef}
        type="text"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid}
        className="placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-xs outline-none"
        placeholder={placeholder}
        value={query.text}
        onChange={(event) => onChange({ ...query, text: event.target.value })}
        onKeyDown={handleKeyDown}
      />
      <SearchIconButton
        label="Match case (Alt+C)"
        pressed={query.caseSensitive}
        onClick={() => toggle('caseSensitive')}
      >
        <span className="text-[11px] leading-none font-semibold">Aa</span>
      </SearchIconButton>
      <SearchIconButton
        label="Match whole word (Alt+W)"
        pressed={query.wholeWord}
        onClick={() => toggle('wholeWord')}
      >
        <IconTypeWord className="size-3.5" />
      </SearchIconButton>
      <SearchIconButton
        label="Use regular expression (Alt+R)"
        pressed={query.regex}
        onClick={() => toggle('regex')}
      >
        <IconRegex className="size-3.5" />
      </SearchIconButton>
      {trailing}
    </div>
  );
}

interface SearchIconButtonProps {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick(): void;
  // Set for toggles; omitted for plain actions.
  pressed?: boolean;
}

// Compact icon button for the search widgets (toggles, match navigation,
// close). It keeps focus where it was on press so typing in the query field
// continues uninterrupted.
export function SearchIconButton({
  children,
  disabled,
  label,
  onClick,
  pressed,
}: SearchIconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      className={cn(
        'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm transition outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40',
        pressed === true &&
          'text-foreground bg-[color-mix(in_srgb,currentColor_14%,transparent)] ring-1 ring-[color-mix(in_srgb,currentColor_35%,transparent)]'
      )}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
