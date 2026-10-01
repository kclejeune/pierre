'use client';

import { IconChevronSm, IconX } from '@pierre/icons';
import {
  type KeyboardEvent,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DiffSearchInput,
  SearchIconButton,
  useActiveMatch,
  useDiffSearchResults,
} from './DiffSearchInput';
import type { DiffSearchController } from './useDiffSearchController';
import { cn } from '@/lib/cn';
import {
  type DiffSearchMatch,
  type DiffSearchQuery,
  getDiffSearchMatchKey,
  groupMatchesByItem,
} from '@/lib/diffSearch';
import { splitPath } from '@/lib/splitPath';

// Rows rendered at once; more appear on demand so a one-letter query over a
// huge diff does not mount thousands of rows.
const RESULT_PAGE_SIZE = 500;
// Characters of a result line kept before the match; the rest is elided.
const RESULT_LEADING_CHARS = 32;
const RESULT_TRAILING_CHARS = 200;

// A fixed list of matches produced elsewhere (go-to-definition candidates)
// shown in place of the query's results until dismissed.
export interface DiffSearchPinnedResults {
  title: string;
  matches: DiffSearchMatch[];
}

interface DiffSearchPanelProps {
  controller: DiffSearchController;
  // Bumped to focus and select the query field (Ctrl+Shift+F).
  focusRequest: number;
  onClearPinned(): void;
  pinned: DiffSearchPinnedResults | null;
  query: DiffSearchQuery;
  setQuery(query: DiffSearchQuery): void;
  visible: boolean;
}

// The Ctrl+Shift+F panel: searches every file in the diff and lists matches
// grouped by file. By default only the lines the patch carries are
// searchable; the full-files control loads both versions of each changed file
// so unchanged code is searched too.
export function DiffSearchPanel({
  controller,
  focusRequest,
  onClearPinned,
  pinned,
  query,
  setQuery,
  visible,
}: DiffSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [collapsedItems, setCollapsedItems] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [renderLimit, setRenderLimit] = useState(RESULT_PAGE_SIZE);
  const results = useDiffSearchResults(
    controller,
    query,
    visible && pinned == null ? 'all' : null
  );
  const matches = pinned?.matches ?? results.matches;
  const { showMatches, clearMatches, navigateTo } = controller;
  const { activeMatch, select, step } = useActiveMatch(matches, navigateTo);

  // Focus on each Ctrl+Shift+F and whenever the tab becomes visible.
  useEffect(() => {
    if (visible) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusRequest, visible]);

  useEffect(() => {
    setRenderLimit(RESULT_PAGE_SIZE);
  }, [matches]);

  useEffect(() => {
    if (visible) {
      showMatches('panel', matches, activeMatch);
    } else {
      clearMatches('panel');
    }
  }, [activeMatch, clearMatches, matches, showMatches, visible]);
  useEffect(() => () => clearMatches('panel'), [clearMatches]);

  const groups = useMemo(() => groupMatchesByItem(matches), [matches]);

  // Enter walks the results in order, like the find bar.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  const toggleGroup = (itemId: string) => {
    setCollapsedItems((prev) => {
      const next = new Set(prev);
      if (!next.delete(itemId)) {
        next.add(itemId);
      }
      return next;
    });
  };

  let rendered = 0;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-col gap-1.5 px-3">
        <DiffSearchInput
          inputRef={inputRef}
          invalid={results.error != null}
          placeholder="Search all files"
          query={query}
          onChange={(next) => {
            onClearPinned();
            setQuery(next);
          }}
          onKeyDown={handleKeyDown}
        />
        <SearchSummary
          controller={controller}
          error={pinned == null ? results.error : null}
          fileCount={groups.size}
          matchCount={matches.length}
          query={query}
          truncated={pinned == null && results.truncated}
        />
        {pinned != null && (
          <div className="bg-muted/60 flex items-center gap-1 rounded-md px-2 py-1 text-xs">
            <span className="min-w-0 truncate font-medium">{pinned.title}</span>
            <span className="ml-auto">
              <SearchIconButton
                label="Back to search results"
                onClick={onClearPinned}
              >
                <IconX className="size-3" />
              </SearchIconButton>
            </span>
          </div>
        )}
      </div>
      <div
        role="tree"
        aria-label="Search results"
        className="min-h-0 flex-1 overflow-y-auto pb-3 text-xs"
      >
        {[...groups].map(([itemId, groupMatches]) => {
          if (rendered >= renderLimit) {
            return null;
          }
          const collapsed = collapsedItems.has(itemId);
          const visibleMatches = collapsed
            ? []
            : groupMatches.slice(0, renderLimit - rendered);
          rendered += Math.max(1, visibleMatches.length);
          const path = groupMatches[0]?.path ?? itemId;
          const { basename, dirname } = splitPath(path);
          return (
            <div key={itemId} role="treeitem" aria-expanded={!collapsed}>
              <button
                type="button"
                className="hover:bg-muted/60 flex w-full cursor-pointer items-center gap-1 px-2 py-0.5 text-left"
                title={path}
                onClick={() => toggleGroup(itemId)}
              >
                <IconChevronSm
                  className={cn(
                    'text-muted-foreground size-3 shrink-0 transition-transform',
                    collapsed && '-rotate-90'
                  )}
                />
                <span className="min-w-0 truncate font-medium">{basename}</span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate">
                  {dirname}
                </span>
                <span className="text-muted-foreground bg-muted shrink-0 rounded-full px-1.5 tabular-nums">
                  {groupMatches.length}
                </span>
              </button>
              {visibleMatches.map((match) => (
                <ResultRow
                  key={getDiffSearchMatchKey(match)}
                  active={match === activeMatch}
                  match={match}
                  onSelect={select}
                />
              ))}
            </div>
          );
        })}
        {matches.length > rendered && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground w-full cursor-pointer px-3 py-1 text-left"
            onClick={() => setRenderLimit((limit) => limit + RESULT_PAGE_SIZE)}
          >
            Show more results
          </button>
        )}
      </div>
    </div>
  );
}

interface ResultRowProps {
  active: boolean;
  match: DiffSearchMatch;
  onSelect(match: DiffSearchMatch): void;
}

// Memoized: the list re-renders on every keystroke and selection, while each
// row only changes when its match or active state does.
const ResultRow = memo(function ResultRow({
  active,
  match,
  onSelect,
}: ResultRowProps) {
  const { lineText, start, end } = match;
  const leadStart = Math.max(0, start - RESULT_LEADING_CHARS);
  const before = lineText.slice(leadStart, start).trimStart();
  return (
    <button
      type="button"
      className={cn(
        'hover:bg-muted/60 flex w-full cursor-pointer items-baseline gap-2 py-0.5 pr-2 pl-6 text-left font-mono',
        active && 'bg-muted'
      )}
      title={`${match.path}:${match.lineNumber}`}
      onClick={() => onSelect(match)}
    >
      <span
        className={cn(
          'text-muted-foreground w-9 shrink-0 text-right text-[10px] tabular-nums',
          match.kind === 'addition' && 'text-emerald-600 dark:text-emerald-400',
          match.kind === 'deletion' && 'text-red-600 dark:text-red-400'
        )}
      >
        {match.kind === 'addition' ? '+' : match.kind === 'deletion' ? '−' : ''}
        {match.lineNumber}
      </span>
      <span className="min-w-0 flex-1 truncate whitespace-pre">
        {leadStart > 0 ? `…${before}` : before}
        <mark className="rounded-[2px] bg-yellow-400/40 text-inherit dark:bg-yellow-400/30">
          {lineText.slice(start, end)}
        </mark>
        {lineText.slice(end, end + RESULT_TRAILING_CHARS)}
      </span>
    </button>
  );
});

interface SearchSummaryProps {
  controller: DiffSearchController;
  error: string | null;
  fileCount: number;
  matchCount: number;
  query: DiffSearchQuery;
  truncated: boolean;
}

// Result counts plus the scope line: whether unchanged lines are included,
// and the control that loads full files to include them.
function SearchSummary({
  controller,
  error,
  fileCount,
  matchCount,
  query,
  truncated,
}: SearchSummaryProps) {
  const { fullFiles, partialFileCount, loadFullFiles } = controller;
  return (
    <div className="text-muted-foreground flex flex-col gap-0.5 px-0.5 text-[11px]">
      {error != null ? (
        <span className="text-destructive">{error}</span>
      ) : query.text !== '' || matchCount > 0 ? (
        <span>
          {matchCount === 0
            ? 'No results'
            : `${matchCount.toLocaleString()}${truncated ? '+' : ''} ${
                matchCount === 1 ? 'result' : 'results'
              } in ${fileCount.toLocaleString()} ${
                fileCount === 1 ? 'file' : 'files'
              }`}
        </span>
      ) : null}
      {fullFiles.status === 'loading' ? (
        <span>
          Loading full files… {fullFiles.loaded + fullFiles.failed}/
          {fullFiles.total}
        </span>
      ) : partialFileCount > 0 ? (
        <span>
          Changed lines only.{' '}
          <button
            type="button"
            className="hover:text-foreground cursor-pointer underline underline-offset-2"
            title="Fetch both versions of every changed file so unchanged lines are searched too"
            onClick={loadFullFiles}
          >
            Include unchanged lines ({partialFileCount.toLocaleString()}{' '}
            {partialFileCount === 1 ? 'file' : 'files'})
          </button>
        </span>
      ) : fullFiles.status === 'done' ? (
        <span>
          Searching full files
          {fullFiles.failed > 0
            ? ` (${fullFiles.failed} could not be loaded)`
            : ''}
        </span>
      ) : null}
    </div>
  );
}
