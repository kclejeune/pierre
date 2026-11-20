'use client';

import { IconCheck, IconChevronSm, IconFilter, IconMinus } from '@pierre/icons';
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from './Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { Input } from './Input';
import { LabelColorDot } from './LabelColorDot';
import { useModifierKey } from './ShortcutHint';
import { cn } from '@/lib/cn';
import { pullKey, type PullSummary } from '@/lib/githubPullSummaries';
import { authorSearchName, mutedAuthorLabel } from '@/lib/mutedAuthors';
import { includesName } from '@/lib/nameList';
import type { PullLabel } from '@/lib/pullInfoClient';
import {
  clearPullFilters,
  PULL_CHECKS_FILTER_OPTIONS,
  PULL_REVIEW_FILTER_OPTIONS,
  readPullLabelFilters,
  readPullQualifierFilter,
  togglePullLabelFilter,
  togglePullUnlabeledFilter,
  writePullQualifierFilter,
} from '@/lib/pullSearchQuery';

// Options listed before the filter box has to narrow them.
const MAX_LISTED_OPTIONS = 30;

interface PullFilterMenusProps {
  // Shows and edits the muted authors in the Author menu.
  muting?: AuthorMuting;
  onApplyText(text: string): void;
  // The loaded rows: the Author and Label menus offer the names they carry
  // (and those of earlier lists; see useSeenPulls), since a cross-repo list
  // has no single label set to list.
  pulls: readonly PullSummary[];
  text: string;
}

// The /pulls list header's preset filters: Author, Label, Review, and
// Checks. Each one edits a qualifier in the query bar's text rather than
// holding state of its own, so the bar, the URL, and Back stay the one
// source of truth, and a typed term shows as chosen in its menu. The list
// header is a size container (@container/header): with room, the four sit
// inline as their own dropdowns; on a narrow list (beside the preview pane)
// they fold into one "Filters" menu with a submenu each.
export function PullFilterMenus({
  muting,
  onApplyText,
  pulls,
  text,
}: PullFilterMenusProps) {
  const seen = useSeenPulls(pulls);
  const filters = useFilterSections(seen, text, onApplyText, muting);
  const count = filters.reduce((total, filter) => total + filter.active, 0);
  return (
    <>
      <div className="hidden items-center @min-[44rem]/header:flex">
        {filters.map((filter) => (
          <DropdownMenu key={filter.id}>
            <FilterTrigger
              active={filter.active > 0}
              label={filter.label}
              // One choice is visible in the label's color; a count only
              // helps once a filter (Label) holds several.
              count={filter.active > 1 ? filter.active : undefined}
            />
            <DropdownMenuContent
              align="start"
              className="max-h-96 w-64 overflow-y-auto"
            >
              {filter.items}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </div>
      <div className="@min-[44rem]/header:hidden">
        <DropdownMenu>
          <FilterTrigger
            active={count > 0}
            count={count > 0 ? count : undefined}
            icon={<IconFilter className="size-3" />}
            label="Filters"
          />
          <DropdownMenuContent align="start" className="min-w-48">
            {filters.map((filter) => (
              <DropdownMenuSub key={filter.id}>
                <DropdownMenuSubTrigger className="gap-2">
                  {filter.label}
                  {filter.active > 0 && (
                    <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                      {filter.summary}
                    </span>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-96 w-64 overflow-y-auto">
                  {filter.items}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
            {count > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onApplyText(clearPullFilters(text))}
                >
                  Clear filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

// The list toolbar's "label ⌄" menu trigger, shared by the filter menus,
// muting, and sort so they read as one row of peers: muted until the menu
// sets something (`active`), with an optional leading icon and a muted
// count after the label.
export function FilterTrigger({
  active,
  count,
  icon,
  label,
  ...rest
}: {
  active: boolean;
  count?: ReactNode;
  icon?: ReactNode;
  label: ReactNode;
} & Pick<ComponentProps<'button'>, 'aria-label' | 'title'>) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        {...rest}
        variant="ghost"
        size="toolbar"
        className={cn(
          'tabular-nums',
          active ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {icon}
        {label}
        {count != null && (
          <span className="text-muted-foreground">{count}</span>
        )}
        <IconChevronSm className="size-3" />
      </Button>
    </DropdownMenuTrigger>
  );
}

// Rows can't be the options' only source: filtering by a label or an author
// drops the rows that carried every other choice. So the menus offer what
// any list loaded on this page has shown, most recent first, kept to
// MAX_SEEN_PULLS rows. Merged during render (React's pattern for state
// derived from a changing prop) rather than in an effect, so a new list's
// names are there on its first render.
const MAX_SEEN_PULLS = 1000;

function mergeSeenPulls(
  seen: ReadonlyMap<string, PullSummary>,
  pulls: readonly PullSummary[]
): Map<string, PullSummary> {
  const merged = new Map<string, PullSummary>();
  for (const pull of pulls) {
    merged.set(pullKey(pull), pull);
  }
  for (const [key, pull] of seen) {
    if (merged.size >= MAX_SEEN_PULLS) {
      break;
    }
    if (!merged.has(key)) {
      merged.set(key, pull);
    }
  }
  return merged;
}

function useSeenPulls(pulls: readonly PullSummary[]): PullSummary[] {
  const [seen, setSeen] = useState(() => mergeSeenPulls(new Map(), pulls));
  const [merged, setMerged] = useState(pulls);
  if (pulls !== merged) {
    setMerged(pulls);
    setSeen(mergeSeenPulls(seen, pulls));
  }
  return useMemo(() => [...seen.values()], [seen]);
}

interface FilterSection {
  // How many terms this filter sets (labels can set several).
  active: number;
  id: string;
  items: ReactNode;
  label: string;
  // The folded menu's hint of what's chosen ("approved", "2").
  summary: string;
}

// The four filters' triggers and menu bodies, shared by the inline and
// folded layouts.
function useFilterSections(
  pulls: readonly PullSummary[],
  text: string,
  onApplyText: (text: string) => void,
  muting: AuthorMuting | undefined
): FilterSection[] {
  const author = readPullQualifierFilter(text, 'author');
  const labels = readPullLabelFilters(text);
  const labelCount =
    labels.include.length + labels.exclude.length + (labels.unlabeled ? 1 : 0);
  const preset = (key: 'review' | 'status', label: string, id: string) => {
    const value = readPullQualifierFilter(text, key)?.toLowerCase() ?? '';
    const options =
      key === 'review'
        ? PULL_REVIEW_FILTER_OPTIONS
        : PULL_CHECKS_FILTER_OPTIONS;
    return {
      active: value === '' ? 0 : 1,
      id,
      items: (
        <PresetItems
          options={options}
          value={value}
          onChoose={(next) =>
            onApplyText(
              writePullQualifierFilter(text, key, next === '' ? null : next)
            )
          }
        />
      ),
      label,
      summary: options.find((option) => option.value === value)?.label ?? value,
    };
  };
  return [
    {
      active: author == null ? 0 : 1,
      id: 'author',
      items: (
        <AuthorItems
          current={author}
          muting={muting}
          pulls={pulls}
          onChoose={(next) =>
            onApplyText(writePullQualifierFilter(text, 'author', next))
          }
        />
      ),
      label: 'Author',
      summary: author == null ? '' : mutedAuthorLabel(author),
    },
    {
      active: labelCount,
      id: 'label',
      items: <LabelItems pulls={pulls} text={text} onApplyText={onApplyText} />,
      label: 'Label',
      summary: String(labelCount),
    },
    preset('review', 'Review', 'review'),
    preset('status', 'Checks', 'checks'),
  ];
}

// A single-choice list (Review, Checks): the "any" option first, a check on
// the current one.
function PresetItems({
  onChoose,
  options,
  value,
}: {
  onChoose(value: string): void;
  options: readonly { label: string; value: string }[];
  value: string;
}) {
  return options.map((option) => (
    <DropdownMenuItem
      key={option.value}
      selected={option.value === value}
      className="gap-2"
      onSelect={() => onChoose(option.value)}
    >
      <IconCheck
        className={cn('size-3.5', option.value !== value && 'invisible')}
      />
      {option.label}
    </DropdownMenuItem>
  ));
}

// The menu's filter box. Radix menus treat typed keys as typeahead and arrow
// keys as item navigation, so the box keeps its keys (except Escape, which
// still closes the menu, and ArrowDown, which moves into the list). Enter
// applies the typed name as is, for names the list doesn't offer.
function MenuFilterInput({
  onSubmit,
  placeholder,
  query,
  setQuery,
}: {
  onSubmit(value: string): void;
  placeholder: string;
  query: string;
  setQuery(query: string): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // After the menu's own focus handling, which focuses the content.
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' || event.key === 'ArrowDown') {
      return;
    }
    event.stopPropagation();
    const value = query.trim();
    if (event.key === 'Enter' && value !== '') {
      event.preventDefault();
      onSubmit(value);
    }
  };
  return (
    <div className="p-1">
      <Input
        ref={ref}
        inputSize="sm"
        placeholder={placeholder}
        value={query}
        aria-label={placeholder}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

// Most pulls first, then alphabetical. Counts compare without subtraction,
// since chosen-but-unloaded options use Infinity to sort first.
function byCountThenName(
  countA: number,
  countB: number,
  nameA: string,
  nameB: string
): number {
  if (countA !== countB) {
    return countA > countB ? -1 : 1;
  }
  return nameA.localeCompare(nameB);
}

// Authors of the loaded rows, most pulls first, in the form author: needs
// (app/<slug> for bots).
function useAuthorOptions(pulls: readonly PullSummary[]): string[] {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const pull of pulls) {
      const name = authorSearchName(pull);
      if (name != null) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return [...counts]
      .sort((a, b) => byCountThenName(a[1], b[1], a[0], b[0]))
      .map(([name]) => name);
  }, [pulls]);
}

// The Author menu's view of the muted list (components/useMutedAuthors).
// Muting is a saved preference rather than a query term, so it stays out of
// the search text; the menu only shows it and edits it.
export interface AuthorMuting {
  // The muted list is at MAX_MUTED_AUTHORS; muting more is disabled.
  full: boolean;
  muted: readonly string[];
  onMute(authors: readonly string[]): void;
  onUnmute(author: string): void;
}

// Author choices: a click shows only that author's pulls (or clears the
// choice); with muting, Alt-click (or Alt+Enter) mutes or unmutes instead,
// leaving the menu open like the Label menu's exclusions. Muted authors list
// in their own section, struck through, since their pulls are left out.
function AuthorItems({
  current,
  muting,
  onChoose,
  pulls,
}: {
  current: string | undefined;
  muting?: AuthorMuting;
  onChoose(author: string | null): void;
  pulls: readonly PullSummary[];
}) {
  const [query, setQuery] = useState('');
  const modifier = useModifierKey();
  const altKey = modifier === '⌘' ? '⌥' : 'Alt';
  // Whether the pointer or key selecting an item held Alt (Radix's onSelect
  // event doesn't carry modifier keys).
  const muteRef = useRef(false);
  const trackModifier = (event: { altKey: boolean }) => {
    muteRef.current = event.altKey;
  };
  const muted = muting?.muted ?? [];
  const loaded = useAuthorOptions(pulls);
  const needle = query.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(needle);
  const options = (
    current == null || includesName(loaded, current)
      ? loaded
      : [current, ...loaded]
  )
    .filter((name) => !includesName(muted, name) && matches(name))
    .slice(0, MAX_LISTED_OPTIONS);
  const mutedOptions = muted.filter(matches);
  const renderItem = (name: string, isMuted: boolean) => {
    const chosen = name.toLowerCase() === current?.toLowerCase();
    return (
      <DropdownMenuItem
        key={name}
        selected={chosen}
        className="gap-2"
        title={isMuted ? `${mutedAuthorLabel(name)} is muted` : undefined}
        onPointerDown={trackModifier}
        onKeyDown={trackModifier}
        onSelect={(event) => {
          if (muting != null && muteRef.current) {
            event.preventDefault();
            if (isMuted) {
              muting.onUnmute(name);
            } else if (!muting.full) {
              muting.onMute([name]);
            }
            return;
          }
          onChoose(chosen ? null : name);
        }}
      >
        {isMuted && !chosen ? (
          <IconMinus className="text-muted-foreground size-3.5" />
        ) : (
          <IconCheck className={cn('size-3.5', !chosen && 'invisible')} />
        )}
        <span
          className={cn(
            'truncate',
            isMuted && !chosen && 'text-muted-foreground line-through'
          )}
        >
          {mutedAuthorLabel(name)}
        </span>
        {name.startsWith('app/') && (
          <span className="text-muted-foreground ml-auto text-xs">bot</span>
        )}
      </DropdownMenuItem>
    );
  };
  return (
    <>
      <MenuFilterInput
        placeholder="Filter authors"
        query={query}
        setQuery={setQuery}
        onSubmit={(value) => onChoose(value)}
      />
      {current != null && (
        <DropdownMenuItem className="gap-2" onSelect={() => onChoose(null)}>
          <span className="size-3.5" />
          Any author
        </DropdownMenuItem>
      )}
      {options.map((name) => renderItem(name, false))}
      {mutedOptions.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            Muted
          </DropdownMenuLabel>
          {mutedOptions.map((name) => renderItem(name, true))}
        </>
      )}
      {options.length === 0 && mutedOptions.length === 0 && needle !== '' && (
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Press Enter to filter by {query.trim()}
        </DropdownMenuLabel>
      )}
      {muting != null && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            {muting.full
              ? `Muted list is full; ${altKey}-click a muted author to unmute`
              : `${altKey}-click to mute or unmute an author`}
          </DropdownMenuLabel>
        </>
      )}
    </>
  );
}

// Labels of the loaded rows, most pulls first, plus any the text already
// filters on that no loaded row carries (an excluded label never appears
// on the rows it filters out).
function useLabelOptions(
  pulls: readonly PullSummary[],
  chosen: readonly string[]
): PullLabel[] {
  return useMemo(() => {
    const byName = new Map<string, { count: number; label: PullLabel }>();
    for (const pull of pulls) {
      for (const label of pull.labels ?? []) {
        const key = label.name.toLowerCase();
        const entry = byName.get(key);
        if (entry == null) {
          byName.set(key, { count: 1, label });
        } else {
          entry.count += 1;
        }
      }
    }
    for (const name of chosen) {
      if (!byName.has(name.toLowerCase())) {
        byName.set(name.toLowerCase(), {
          count: Infinity,
          label: { color: '', name },
        });
      }
    }
    return [...byName.values()]
      .sort((a, b) =>
        byCountThenName(a.count, b.count, a.label.name, b.label.name)
      )
      .map((entry) => entry.label);
  }, [chosen, pulls]);
}

// Label choices toggle without closing the menu, so several can be picked in
// one visit; Alt-click (or Alt+Enter) excludes instead of including.
function LabelItems({
  onApplyText,
  pulls,
  text,
}: {
  onApplyText(text: string): void;
  pulls: readonly PullSummary[];
  text: string;
}) {
  const [query, setQuery] = useState('');
  const modifier = useModifierKey();
  const altKey = modifier === '⌘' ? '⌥' : 'Alt';
  // Whether the pointer or key that's selecting an item held Alt. Radix's
  // onSelect event doesn't carry modifier keys.
  const excludeRef = useRef(false);
  // Memoized on the text, so the options list only rebuilds when it changes.
  const filters = useMemo(() => readPullLabelFilters(text), [text]);
  const chosen = useMemo(
    () => [...filters.include, ...filters.exclude],
    [filters]
  );
  const loaded = useLabelOptions(pulls, chosen);
  const needle = query.trim().toLowerCase();
  const options = loaded
    .filter((label) => label.name.toLowerCase().includes(needle))
    .slice(0, MAX_LISTED_OPTIONS);
  const modeOf = (name: string) =>
    includesName(filters.include, name)
      ? 'include'
      : includesName(filters.exclude, name)
        ? 'exclude'
        : null;
  const trackModifier = (event: { altKey: boolean }) => {
    excludeRef.current = event.altKey;
  };
  return (
    <>
      <MenuFilterInput
        placeholder="Filter labels"
        query={query}
        setQuery={setQuery}
        onSubmit={(value) =>
          onApplyText(togglePullLabelFilter(text, value, 'include'))
        }
      />
      <DropdownMenuItem
        selected={filters.unlabeled}
        className="gap-2"
        onSelect={(event) => {
          event.preventDefault();
          onApplyText(togglePullUnlabeledFilter(text));
        }}
      >
        <IconCheck
          className={cn('size-3.5', !filters.unlabeled && 'invisible')}
        />
        Unlabeled
      </DropdownMenuItem>
      {options.length > 0 && <DropdownMenuSeparator />}
      {options.map((label) => {
        const mode = modeOf(label.name);
        return (
          <DropdownMenuItem
            key={label.name}
            selected={mode != null}
            className="gap-2"
            title={
              mode === 'exclude'
                ? `Excluding ${label.name}`
                : mode === 'include'
                  ? `Showing only ${label.name}`
                  : undefined
            }
            onPointerDown={trackModifier}
            onKeyDown={trackModifier}
            onSelect={(event) => {
              event.preventDefault();
              onApplyText(
                togglePullLabelFilter(
                  text,
                  label.name,
                  excludeRef.current ? 'exclude' : 'include'
                )
              );
            }}
          >
            {mode === 'exclude' ? (
              <IconMinus className="text-muted-foreground size-3.5" />
            ) : (
              <IconCheck
                className={cn('size-3.5', mode !== 'include' && 'invisible')}
              />
            )}
            <LabelColorDot className="size-2" color={label.color} />
            <span
              className={cn(
                'truncate',
                mode === 'exclude' && 'text-muted-foreground line-through'
              )}
            >
              {label.name}
            </span>
          </DropdownMenuItem>
        );
      })}
      {options.length === 0 && needle !== '' && (
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Press Enter to filter by {query.trim()}
        </DropdownMenuLabel>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
        {altKey}-click to exclude a label
      </DropdownMenuLabel>
    </>
  );
}
