'use client';

import { IconChevronSm, IconX } from '@pierre/icons';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { FooterHint } from './CommandPalette';
import { RepoName, ScopeIcon } from './RepoName';
import { ShortcutHint } from './ShortcutHint';
import { useRepoLabels } from './useRepoLabels';
import { useResettableState } from './useResettableState';
import { cn } from '@/lib/cn';
import { splitRepoName } from '@/lib/pinnedRepos';
import { isEditableEventTarget } from '@/lib/platform';
import {
  applyQuerySuggestion,
  getQuerySuggestions,
  type QuerySuggestion,
  queryWordAtCaret,
} from '@/lib/pullQuerySuggestions';
import { DEFAULT_QUERY_TEXT, type PullScope } from '@/lib/pullScopes';
import {
  KNOWN_PULL_QUALIFIERS,
  type PullQueryToken,
  tokenizePullQuery,
} from '@/lib/pullSearchQuery';

interface PullQueryBarProps {
  // The search the list is showing; edits stay local until Enter applies
  // them.
  appliedText: string;
  onApply(text: string): void;
  onOpenScope(): void;
  scope: PullScope;
}

// The /pulls search control: the scope (which repositories) and the GitHub
// search text, fused into one bar the way GitHub's own PR list reads
// "repo:x is:open …". The text half renders its own syntax highlighting:
// a transparent input sits over a mirror of the same text split into
// qualifier tokens, so the caret, selection, and IME stay native.
export function PullQueryBar({
  appliedText,
  onApply,
  onOpenScope,
  scope,
}: PullQueryBarProps) {
  // Snaps back to the applied text when it changes from outside (state
  // toggle, sort menu, back/forward).
  const [draft, setDraft] = useResettableState(appliedText);
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const dirty = draft.trim() !== appliedText.trim();

  // "/" focuses the bar from anywhere on the page, as on GitHub.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableEventTarget(event)
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Keeps the mirror under the input's text when it scrolls horizontally
  // (long searches, caret moves).
  const syncScroll = () => {
    const input = inputRef.current;
    if (input != null && mirrorRef.current != null) {
      mirrorRef.current.style.transform = `translateX(${-input.scrollLeft}px)`;
    }
  };
  useEffect(syncScroll, [draft]);
  const completion = useQueryCompletion({
    draft,
    inputRef,
    onAccepted: syncScroll,
    scope,
    setDraft,
  });

  return (
    <form
      role="search"
      aria-label="Search pull requests"
      // A size container (@container/query) so the scope button can size
      // its label to the bar itself, which narrows beside the preview pane.
      className="bg-background focus-within:border-ring focus-within:ring-ring/40 @container/query relative flex h-10 min-w-0 items-stretch rounded-lg border shadow-xs transition-[border-color,box-shadow] focus-within:ring-[3px]"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft.trim());
      }}
    >
      <ScopeButton scope={scope} onClick={onOpenScope} />
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-3 font-mono text-[13px] whitespace-pre"
        >
          <span ref={mirrorRef} className="will-change-transform">
            <HighlightedQuery text={draft} />
          </span>
        </div>
        <input
          ref={inputRef}
          role="combobox"
          aria-activedescendant={completion.activeId}
          aria-autocomplete="list"
          aria-controls={completion.listId}
          aria-expanded={completion.suggestions != null}
          aria-label="GitHub search qualifiers"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="caret-foreground placeholder:text-muted-foreground relative h-full w-full bg-transparent px-3 font-mono text-[13px] text-transparent outline-none selection:bg-sky-500/25"
          placeholder="Filter with GitHub search, e.g. label:bug author:octocat"
          spellCheck={false}
          value={draft}
          onBlur={() => completion.setCaret(null)}
          onChange={(event) => {
            setDraft(event.target.value);
            completion.onEdit(event.target.selectionStart);
          }}
          onKeyDown={(event) => {
            if (completion.onKeyDown(event)) {
              return;
            }
            if (event.key === 'Escape' && dirty) {
              event.preventDefault();
              setDraft(appliedText);
            }
          }}
          onScroll={syncScroll}
          onSelect={(event) => {
            syncScroll();
            completion.setCaret(event.currentTarget.selectionStart);
          }}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1 pr-2">
        {dirty && (
          <kbd
            className="text-muted-foreground bg-muted hidden h-5 items-center rounded border px-1.5 font-mono text-[10px] sm:inline-flex"
            title="Press Enter to search"
          >
            ↵ search
          </kbd>
        )}
        {draft.trim() !== DEFAULT_QUERY_TEXT && (
          <button
            type="button"
            aria-label="Reset search"
            title={`Reset to “${DEFAULT_QUERY_TEXT}”`}
            className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring flex size-6 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2"
            onClick={() => {
              setDraft(DEFAULT_QUERY_TEXT);
              onApply(DEFAULT_QUERY_TEXT);
              inputRef.current?.focus();
            }}
          >
            <IconX className="size-3.5" />
          </button>
        )}
      </div>
      {completion.suggestions != null && (
        <SuggestionList
          activeIndex={completion.activeIndex}
          id={completion.listId}
          items={completion.suggestions.items}
          optionId={completion.optionId}
          onAccept={completion.accept}
          onHover={completion.setActiveIndex}
        />
      )}
    </form>
  );
}

// Autocomplete state for the search bar: where the caret is (null while the
// input is blurred), which suggestion arrow keys have highlighted, and
// whether Escape closed the list until the next edit. Repo labels are only
// fetched once a `label:` value is being typed in a single-repo scope.
function useQueryCompletion({
  draft,
  inputRef,
  onAccepted,
  scope,
  setDraft,
}: {
  draft: string;
  inputRef: RefObject<HTMLInputElement | null>;
  // Runs after an accepted completion's caret is placed.
  onAccepted(): void;
  scope: PullScope;
  setDraft(text: string): void;
}) {
  const [caret, setCaret] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();

  const typingLabel =
    caret != null &&
    /^-?label:/.test(queryWordAtCaret(draft, caret)?.typed ?? '');
  const labelRepo = useMemo(
    () =>
      typingLabel && scope.kind === 'repo' ? splitRepoName(scope.repo) : null,
    [scope, typingLabel]
  );
  const repoLabels = useRepoLabels(labelRepo);
  const labels = useMemo(
    () =>
      repoLabels?.kind === 'ready'
        ? repoLabels.labels.map((label) => label.name)
        : undefined,
    [repoLabels]
  );

  const suggestions = useMemo(
    () =>
      caret == null || dismissed
        ? null
        : getQuerySuggestions(draft, caret, {
            labels,
            // oxlint-disable-next-line react/purity -- relative-date suggestions ("last 7 days") must use the current time each time the draft changes; a mount-time snapshot would go stale in a long-lived tab.
            now: new Date(),
          }),
    [caret, dismissed, draft, labels]
  );
  const itemCount = suggestions?.items.length ?? 0;
  const active = activeIndex < itemCount ? activeIndex : -1;
  const optionId = (index: number) => `${listId}-option-${index}`;

  // After any text change: track the new caret, clear the highlight, and
  // let a dismissed list come back.
  const onEdit = (nextCaret: number | null) => {
    setCaret(nextCaret);
    setActiveIndex(-1);
    setDismissed(false);
  };

  // Swaps the word under the caret for the chosen completion and puts the
  // caret after it, so a key's values (or the next qualifier) can follow.
  const accept = (item: QuerySuggestion) => {
    if (suggestions == null) {
      return;
    }
    const next = applyQuerySuggestion(draft, suggestions, item);
    setDraft(next.text);
    onEdit(next.caret);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(next.caret, next.caret);
      onAccepted();
    });
  };

  return {
    accept,
    activeId: active >= 0 ? optionId(active) : undefined,
    activeIndex: active,
    listId,
    onEdit,
    optionId,
    setActiveIndex,
    setCaret,
    suggestions,
    // Arrows move the highlight, Tab completes (the highlighted item or the
    // first), Enter completes only a highlighted item so a plain Enter still
    // searches, and Escape closes the list. Returns whether it handled the
    // key, in which case the input's own handling should stop.
    onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): boolean {
      if (suggestions == null || event.nativeEvent.isComposing) {
        return false;
      }
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setActiveIndex(
            active === -1 && step === -1
              ? itemCount - 1
              : (active + step + itemCount) % itemCount
          );
          break;
        }
        case 'Tab':
          if (event.shiftKey) {
            return false;
          }
          accept(suggestions.items[Math.max(active, 0)]);
          break;
        case 'Enter':
          if (active === -1) {
            return false;
          }
          accept(suggestions.items[active]);
          break;
        case 'Escape':
          setDismissed(true);
          break;
        default:
          return false;
      }
      event.preventDefault();
      return true;
    },
  };
}

// The completion dropdown under the bar. Items keep the input focused on
// press (mousedown is prevented) so clicking one reads like pressing Tab.
function SuggestionList({
  activeIndex,
  id,
  items,
  onAccept,
  onHover,
  optionId,
}: {
  activeIndex: number;
  id: string;
  items: QuerySuggestion[];
  onAccept(item: QuerySuggestion): void;
  onHover(index: number): void;
  optionId(index: number): string;
}) {
  return (
    <div className="bg-popover text-popover-foreground absolute inset-x-0 top-full z-50 mt-1.5 overflow-hidden rounded-lg border shadow-lg">
      <ul
        id={id}
        role="listbox"
        aria-label="Search suggestions"
        className="py-1"
      >
        {items.map((item, index) => {
          const colon = item.text.indexOf(':');
          return (
            <li
              key={item.text}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                'flex cursor-pointer items-baseline gap-3 px-3 py-1.5',
                index === activeIndex && 'bg-accent'
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                onAccept(item);
              }}
              onMouseEnter={() => onHover(index)}
            >
              <span className="min-w-0 truncate font-mono text-[13px]">
                <span className="text-muted-foreground">
                  {item.text.slice(0, colon + 1)}
                </span>
                <span className="text-sky-700 dark:text-sky-300">
                  {item.text.slice(colon + 1)}
                </span>
              </span>
              {item.detail != null && (
                <span className="text-muted-foreground ml-auto shrink-0 truncate text-xs">
                  {item.detail}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="text-muted-foreground bg-muted/40 flex gap-3 border-t px-3 py-1.5 text-[11px]">
        <FooterHint keys="⇥" label="Complete" />
        <FooterHint keys="↑↓" label="Choose" />
        <FooterHint keys="esc" label="Dismiss" />
      </div>
    </div>
  );
}

// The bar's left half: what's being searched, opening the command palette
// to switch repositories.
function ScopeButton({
  onClick,
  scope,
}: {
  onClick(): void;
  scope: PullScope;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label="Switch repository"
      title="Switch repository"
      className="hover:bg-accent/60 focus-visible:ring-ring flex max-w-[55%] min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-l-[inherit] border-r pr-2 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset sm:max-w-[60%]"
      onClick={onClick}
    >
      <ScopeIcon
        className="text-muted-foreground size-4 shrink-0"
        scope={scope}
      />
      <ScopeLabel scope={scope} />
      <IconChevronSm className="text-muted-foreground size-3 shrink-0" />
      <ShortcutHint
        className="text-muted-foreground hidden md:inline-flex"
        shortcutKey="k"
      />
    </button>
  );
}

function ScopeLabel({ scope }: { scope: PullScope }) {
  if (scope.kind !== 'repo') {
    return (
      <span className="min-w-0 truncate text-sm font-medium">
        {scope.kind === 'all' ? 'All repositories' : 'Pinned'}
      </span>
    );
  }
  // The full owner/repo shows once the bar has room for it beside a usable
  // query field (40rem); a narrower bar shows the repo name alone rather
  // than cutting it off mid-word. The title and the scope strip's chip
  // below still carry the owner.
  return (
    <RepoName
      ownerClassName="hidden @min-[40rem]/query:inline"
      repo={scope.repo}
    />
  );
}

// Token colors (color only: weight changes would shift glyphs out from under
// the input's own text): the qualifier's key recedes so its value reads first; @me
// picks up the amber the row chips use for "waiting on you"; negations read
// red; boolean operators stand apart from values; keys GitHub doesn't know
// get a wavy underline so typos surface before the search returns nothing.
function HighlightedQuery({ text }: { text: string }) {
  return (
    <>
      {tokenizePullQuery(text).map((token, index) => (
        <QueryToken key={index} token={token} />
      ))}
    </>
  );
}

function QueryToken({ token }: { token: PullQueryToken }) {
  switch (token.kind) {
    case 'space':
      return <>{token.raw}</>;
    case 'paren':
      return <span className="text-muted-foreground">{token.raw}</span>;
    case 'operator':
      return (
        <span className="text-violet-600 dark:text-violet-400">
          {token.raw}
        </span>
      );
    case 'text':
      return <span className="text-foreground">{token.raw}</span>;
    case 'qualifier': {
      const known = KNOWN_PULL_QUALIFIERS.has(token.key ?? '');
      const value = token.value ?? '';
      return (
        <span
          className={cn(
            !known &&
              'underline decoration-amber-500/70 decoration-wavy underline-offset-4'
          )}
        >
          {token.negated === true && (
            <span className="text-red-600 dark:text-red-400">-</span>
          )}
          <span
            className={cn(
              token.negated === true
                ? 'text-red-600/80 dark:text-red-400/80'
                : 'text-muted-foreground'
            )}
          >
            {token.raw.slice(
              token.negated === true ? 1 : 0,
              token.raw.length - value.length
            )}
          </span>
          <span
            className={cn(
              value === '@me'
                ? 'text-amber-600 dark:text-amber-400'
                : value.startsWith('"')
                  ? 'text-[#18a46c]'
                  : 'text-sky-700 dark:text-sky-300'
            )}
          >
            {value}
          </span>
        </span>
      );
    }
  }
}
