'use client';

import { IconChevronSm, IconX } from '@pierre/icons';
import { useEffect, useRef } from 'react';

import { RepoName, ScopeIcon } from './RepoName';
import { ShortcutHint } from './ShortcutHint';
import { useResettableState } from './useResettableState';
import { cn } from '@/lib/cn';
import { isEditableEventTarget } from '@/lib/platform';
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

  return (
    <form
      role="search"
      aria-label="Search pull requests"
      className="bg-background focus-within:border-ring focus-within:ring-ring/40 flex h-10 min-w-0 items-stretch rounded-lg border shadow-xs transition-[border-color,box-shadow] focus-within:ring-[3px]"
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
          aria-label="GitHub search qualifiers"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="caret-foreground placeholder:text-muted-foreground relative h-full w-full bg-transparent px-3 font-mono text-[13px] text-transparent outline-none selection:bg-sky-500/25"
          placeholder="Filter with GitHub search, e.g. label:bug author:octocat"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && dirty) {
              event.preventDefault();
              setDraft(appliedText);
            }
          }}
          onScroll={syncScroll}
          onSelect={syncScroll}
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
    </form>
  );
}

// The bar's left half: what's being searched, opening the repo switcher.
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
      className="hover:bg-accent/60 focus-visible:ring-ring flex max-w-[55%] min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-l-[inherit] border-r pr-2 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset sm:max-w-[45%]"
      onClick={onClick}
    >
      <ScopeIcon
        className="text-muted-foreground size-4 shrink-0"
        scope={scope}
      />
      <ScopeLabel scope={scope} />
      <IconChevronSm className="text-muted-foreground size-3 shrink-0 rotate-90" />
      <ShortcutHint
        className="text-muted-foreground hidden md:inline-flex"
        paletteId="repo-scope"
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
  return <RepoName hideOwnerOnMobile repo={scope.repo} />;
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
