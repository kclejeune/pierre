'use client';

import { IconCheck, IconChevronSm, IconPin, IconPlus } from '@pierre/icons';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/Button';
import { ButtonGroup, ButtonGroupItem } from '@/components/ButtonGroup';
import {
  DashboardSectionState,
  SectionError,
  SkeletonRows,
} from '@/components/DashboardSectionState';
import {
  DashboardShell,
  SECTION_CARD_CLASS,
} from '@/components/DashboardShell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/DropdownMenu';
import { GitHubTokenControl } from '@/components/GitHubTokenControl';
import { openPalette } from '@/components/PaletteDialog';
import { PullQueryBar } from '@/components/PullQueryBar';
import { PullRequestRow } from '@/components/PullRequestRow';
import { RepoScopePalette } from '@/components/RepoScopePalette';
import { formatShortcut, useModifierKey } from '@/components/ShortcutHint';
import { Switch } from '@/components/Switch';
import {
  pullKey,
  type PullSearchRequest,
  useDashboardPulls,
} from '@/components/useDashboardPulls';
import { useGitHubToken } from '@/components/useGitHubToken';
import { usePinnedRepos } from '@/components/usePinnedRepos';
import { cn } from '@/lib/cn';
import {
  involvementsUseReviewRequests,
  normalizePullInvolvements,
  PULL_ACTIVITY_LABELS,
  PULL_INVOLVEMENTS,
  type PullAudience,
  type PullInvolvement,
} from '@/lib/githubPullSummaries';
import { isRepoPinned, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import {
  audienceAnyoneAllowed,
  DEFAULT_QUERY_TEXT,
  defaultAudience,
  type PullScope,
  type PullsPageState,
  readPullsPageState,
  recordRecentRepo,
  resolveAudience,
  scopeRepos,
  scopesEqual,
  writePullsPageState,
} from '@/lib/pullScopes';
import {
  PULL_SORT_OPTIONS,
  type PullStateFilter,
  readPullSort,
  readPullStateFilter,
  writePullSort,
  writePullStateFilter,
} from '@/lib/pullSearchQuery';
import { splitPath } from '@/lib/splitPath';

export function PullsDashboard() {
  const tokenState = useGitHubToken();
  const { clearToken, hasToken, hydrated, setToken, tokenVersion } = tokenState;
  const modifier = useModifierKey();

  return (
    <DashboardShell section="pulls" tokenState={tokenState}>
      {!hydrated ? null : hasToken ? (
        <SignedInDashboard tokenVersion={tokenVersion} />
      ) : (
        <div className={SECTION_CARD_CLASS}>
          <p className="text-muted-foreground border-b px-4 py-3 text-sm">
            Sign in with GitHub to search pull requests across your
            repositories, or narrow to one repository with{' '}
            {formatShortcut(modifier, 'K')}.
          </p>
          <GitHubTokenControl
            active={hasToken}
            className="px-4 py-3"
            onClear={clearToken}
            onSave={setToken}
            title="GitHub access"
          />
        </div>
      )}
    </DashboardShell>
  );
}

// The page's URL-backed state (scope, involvement chips, team-requests
// switch, search text) with
// history handling: switching scope pushes an entry so Back returns to the
// previous repository, while filter edits replace the current one.
function usePullsPageState() {
  const [state, setState] = useState(() =>
    readPullsPageState(window.location.search)
  );
  useEffect(() => {
    // Canonicalizes the URL once (e.g. a legacy ?bucket= link becomes the
    // ?involves= it maps onto).
    window.history.replaceState(
      window.history.state,
      '',
      writePullsPageState(new URL(window.location.href), state)
    );
    const onPopState = () =>
      setState(readPullsPageState(window.location.search));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // Mount-only: later writes go through `update`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = useCallback(
    (next: PullsPageState, mode: 'push' | 'replace' = 'replace') => {
      setState(next);
      const url = writePullsPageState(new URL(window.location.href), next);
      if (mode === 'push') {
        window.history.pushState(window.history.state, '', url);
      } else {
        window.history.replaceState(window.history.state, '', url);
      }
    },
    []
  );
  return [state, update] as const;
}

// Click opens go through the same open request as cmd+K, so the switcher's
// per-open setup (clearing the query, loading recents) runs for both.
function openRepoSwitcher() {
  openPalette('repo-scope');
}

function SignedInDashboard({ tokenVersion }: { tokenVersion: number }) {
  const modifier = useModifierKey();
  const [page, updatePage] = usePullsPageState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { hydrated, pinned, toggle } = usePinnedRepos();

  // Wait for the single post-mount pin read: the pinned scope searches the
  // pinned list, and fetching before it loads would search everything.
  if (!hydrated) {
    return null;
  }

  const selectScope = (scope: PullScope) => {
    if (scope.kind === 'repo') {
      recordRecentRepo(scope.repo);
    }
    if (scopesEqual(scope, page.scope)) {
      return;
    }
    // Each scope starts on its own default chips (yours across everything,
    // everyone's inside chosen repos); the search text carries over.
    updatePage({ ...page, involves: defaultAudience(scope), scope }, 'push');
  };
  const applyText = (text: string) => updatePage({ ...page, text });
  const involves = resolveAudience(page);
  const repos = scopeRepos(page.scope, pinned);
  // Only searches with a review-request term carry the switch's value, so
  // flipping it doesn't refetch (or re-key the cache for) the others.
  const usesReviewRequests =
    involves !== 'anyone' && involvementsUseReviewRequests(involves);
  const request: PullSearchRequest = {
    involves,
    repos,
    reviewRequests: usesReviewRequests ? page.reviewRequests : undefined,
    text: page.text,
  };

  return (
    <div className="space-y-3">
      <PullQueryBar
        appliedText={page.text}
        scope={page.scope}
        onApply={applyText}
        onOpenScope={openRepoSwitcher}
      />
      <ScopeStrip
        pinned={pinned}
        scope={page.scope}
        onAddPin={openRepoSwitcher}
        onSelect={selectScope}
        onTogglePin={toggle}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-1">
        <AudienceFilter
          anyoneAllowed={audienceAnyoneAllowed(page.scope, page.text)}
          value={involves}
          onChange={(next) => updatePage({ ...page, involves: next })}
        />
        {usesReviewRequests && (
          <label
            className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs"
            title="Also count review requests sent to teams you're on"
          >
            Include team requests
            <Switch
              checked={page.reviewRequests === 'teams'}
              onCheckedChange={(checked) =>
                updatePage({
                  ...page,
                  reviewRequests: checked ? 'teams' : 'direct',
                })
              }
            />
          </label>
        )}
      </div>
      {page.scope.kind === 'pinned' && pinned.length === 0 ? (
        <div className={cn(SECTION_CARD_CLASS, 'px-4 py-6 text-sm')}>
          <p className="font-medium">No pinned repositories yet.</p>
          <p className="text-muted-foreground mt-1">
            Press {formatShortcut(modifier, 'K')}, find a repository, and press{' '}
            {formatShortcut(modifier, '↵')} to pin it. Pinned repositories
            appear above for one-click switching, and this view searches all of
            them at once.
          </p>
        </div>
      ) : (
        <PullList
          request={request}
          scope={page.scope}
          tokenVersion={tokenVersion}
          onApplyText={applyText}
        />
      )}
      <RepoScopePalette
        open={paletteOpen}
        pinned={pinned}
        tokenVersion={tokenVersion}
        onOpenChange={setPaletteOpen}
        onSelectScope={selectScope}
        onTogglePin={toggle}
      />
    </div>
  );
}

// Pins as bookmarks: one-click scopes for the repositories you return to,
// next to the two broad scopes. A repository opened from the switcher but
// not pinned shows as a dashed chip at the end, with its pin button, so
// pinning is something you do to what you're looking at.
function ScopeStrip({
  onAddPin,
  onSelect,
  onTogglePin,
  pinned,
  scope,
}: {
  onAddPin(): void;
  onSelect(scope: PullScope): void;
  onTogglePin(repo: string): void;
  pinned: readonly string[];
  scope: PullScope;
}) {
  const currentRepo = scope.kind === 'repo' ? scope.repo : null;
  const currentIsPinned =
    currentRepo != null && isRepoPinned(pinned, currentRepo);
  // Repo names alone, unless two pins share one.
  const names = pinned.map((repo) => splitPath(repo).basename);
  const ambiguous = new Set(
    names.filter((name, index) => names.indexOf(name) !== index)
  );
  return (
    <nav
      aria-label="Repository scopes"
      className="flex flex-wrap items-center gap-1"
    >
      <ScopeChip
        selected={scope.kind === 'all'}
        onClick={() => onSelect({ kind: 'all' })}
      >
        All
      </ScopeChip>
      {pinned.length > 0 && (
        <ScopeChip
          selected={scope.kind === 'pinned'}
          title={`Search all ${pinned.length} pinned repositories`}
          onClick={() => onSelect({ kind: 'pinned' })}
        >
          <IconPin className="size-3" />
          Pinned
          <span className="text-muted-foreground tabular-nums">
            {pinned.length}
          </span>
        </ScopeChip>
      )}
      <span aria-hidden="true" className="bg-border mx-1 h-4 w-px" />
      {pinned.map((repo, index) => {
        const selected = scopesEqual(scope, { kind: 'repo', repo });
        return (
          <ScopeChip
            key={repo}
            mono
            selected={selected}
            title={repo}
            onClick={() => onSelect({ kind: 'repo', repo })}
            trailing={
              selected ? (
                <PinToggle pinned repo={repo} onToggle={onTogglePin} />
              ) : undefined
            }
          >
            {ambiguous.has(names[index]) ? repo : names[index]}
          </ScopeChip>
        );
      })}
      {currentRepo != null && !currentIsPinned && (
        <ScopeChip
          mono
          selected
          dashed
          title={`${currentRepo} (not pinned)`}
          trailing={
            pinned.length < MAX_PINNED_REPOS ? (
              <PinToggle
                pinned={false}
                repo={currentRepo}
                onToggle={onTogglePin}
              />
            ) : undefined
          }
        >
          {currentRepo}
        </ScopeChip>
      )}
      {pinned.length === 0 && currentRepo == null && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2"
          onClick={onAddPin}
        >
          <IconPlus className="size-3" />
          Pin repositories you check often
        </button>
      )}
    </nav>
  );
}

// A scope chip. Without `onClick` it's a static label (the dashed chip for
// the current, unpinned repo, which is already selected).
function ScopeChip({
  children,
  dashed = false,
  mono = false,
  onClick,
  selected,
  title,
  trailing,
}: {
  children: ReactNode;
  dashed?: boolean;
  mono?: boolean;
  onClick?(): void;
  selected: boolean;
  title?: string;
  trailing?: ReactNode;
}) {
  const labelClassName = cn(
    'flex h-full max-w-56 items-center gap-1 rounded-[inherit] px-2',
    mono && 'font-mono text-[12px]',
    trailing != null && 'pr-1'
  );
  const label = (
    <span className="flex min-w-0 items-center gap-1 truncate">{children}</span>
  );
  return (
    <span
      className={cn(
        'flex h-6 items-center rounded-md border text-xs transition-colors',
        selected
          ? 'bg-background text-foreground shadow-xs'
          : 'text-muted-foreground hover:text-foreground border-transparent',
        dashed && 'border-dashed'
      )}
    >
      {onClick == null ? (
        <span className={labelClassName} title={title}>
          {label}
        </span>
      ) : (
        <button
          type="button"
          aria-current={selected ? 'page' : undefined}
          className={cn(
            labelClassName,
            'focus-visible:ring-ring cursor-pointer outline-none focus-visible:ring-2'
          )}
          title={title}
          onClick={onClick}
        >
          {label}
        </button>
      )}
      {trailing}
    </span>
  );
}

function PinToggle({
  onToggle,
  pinned,
  repo,
}: {
  onToggle(repo: string): void;
  pinned: boolean;
  repo: string;
}) {
  return (
    <button
      type="button"
      aria-label={pinned ? `Unpin ${repo}` : `Pin ${repo}`}
      aria-pressed={pinned}
      title={pinned ? 'Unpin' : 'Pin'}
      className={cn(
        'hover:bg-accent focus-visible:ring-ring mr-0.5 flex size-5 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2',
        pinned ? 'text-foreground' : 'text-muted-foreground'
      )}
      onClick={() => onToggle(repo)}
    >
      <IconPin className="size-3" />
    </button>
  );
}

// Who the list is about. "Anyone" (no involvement terms) is offered once the
// search is narrowed to some repositories; "Involves me" is the OR of every
// involvement; the remaining chips multi-select into a narrower OR, folding
// back into "Involves me" when all are selected.
function AudienceFilter({
  anyoneAllowed,
  onChange,
  value,
}: {
  anyoneAllowed: boolean;
  onChange(next: PullAudience): void;
  value: PullAudience;
}) {
  const selected: readonly PullInvolvement[] = value === 'anyone' ? [] : value;
  const toggle = (involvement: PullInvolvement) =>
    onChange(
      normalizePullInvolvements(
        selected.includes(involvement)
          ? selected.filter((entry) => entry !== involvement)
          : [...selected, involvement]
      )
    );
  return (
    <ButtonGroup
      aria-label="Filter by involvement"
      className="flex-wrap"
      size="sm"
    >
      {anyoneAllowed && (
        <ButtonGroupItem
          aria-pressed={value === 'anyone'}
          selected={value === 'anyone'}
          title="Every pull request in this scope, whoever it involves"
          value="anyone"
          onClick={() => onChange('anyone')}
        >
          Anyone
        </ButtonGroupItem>
      )}
      <ButtonGroupItem
        aria-pressed={value !== 'anyone' && value.length === 0}
        selected={value !== 'anyone' && value.length === 0}
        title="Pull requests involving you in any way below"
        value="me"
        onClick={() => onChange([])}
      >
        Involves me
      </ButtonGroupItem>
      {PULL_INVOLVEMENTS.map((involvement) => (
        <ButtonGroupItem
          key={involvement}
          aria-pressed={selected.includes(involvement)}
          selected={selected.includes(involvement)}
          title={PULL_ACTIVITY_LABELS[involvement]}
          value={involvement}
          onClick={() => toggle(involvement)}
        >
          {PULL_ACTIVITY_LABELS[involvement]}
        </ButtonGroupItem>
      ))}
    </ButtonGroup>
  );
}

const STATE_TOGGLES: readonly { value: PullStateFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

function getEmptyCopy(request: PullSearchRequest, scope: PullScope): string {
  const where =
    scope.kind === 'repo'
      ? ` in ${scope.repo}`
      : scope.kind === 'pinned'
        ? ' in your pinned repositories'
        : '';
  if (request.text.trim() !== DEFAULT_QUERY_TEXT) {
    return `No pull requests${where} match this search.`;
  }
  if (request.involves === 'anyone') {
    return `No open pull requests${where}.`;
  }
  if (request.involves.length > 0) {
    return `No open pull requests${where} match these filters.`;
  }
  return request.reviewRequests === 'teams'
    ? `No open pull requests${where} involving you or your teams.`
    : `No open pull requests${where} involving you.`;
}

// The list card: state toggle, result count, and sort menu over the rows,
// with "Load more" paging at the bottom. The toggle and the menu edit the
// search text (is:/sort: qualifiers), so the bar always shows the whole
// search.
function PullList({
  onApplyText,
  request,
  scope,
  tokenVersion,
}: {
  onApplyText(text: string): void;
  request: PullSearchRequest;
  scope: PullScope;
  tokenVersion: number;
}) {
  const { text } = request;
  const {
    error,
    hasMore,
    loadMore,
    loading,
    loadingMore,
    pulls,
    retry,
    totalCount,
  } = useDashboardPulls(request, tokenVersion);
  const state = readPullStateFilter(text);
  const sort = readPullSort(text);
  const sortLabel =
    PULL_SORT_OPTIONS.find((option) => option.value === sort)?.label ??
    `sort:${sort}`;
  const showRepo = scope.kind !== 'repo';
  return (
    <section
      aria-busy={loading}
      aria-label="Pull requests"
      className={SECTION_CARD_CLASS}
    >
      <div className="bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-2 py-1.5">
        <div
          role="radiogroup"
          aria-label="Pull request state"
          className="flex items-center"
        >
          {STATE_TOGGLES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={state === option.value}
              className={cn(
                'focus-visible:ring-ring h-7 cursor-pointer rounded-md px-2 text-xs outline-none focus-visible:ring-2',
                state === option.value
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() =>
                onApplyText(writePullStateFilter(text, option.value))
              }
            >
              {option.label}
              {state === option.value && !loading && (
                <span className="text-muted-foreground ml-1.5 font-normal tabular-nums">
                  {totalCount.toLocaleString()}
                </span>
              )}
            </button>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground ml-auto h-7"
            >
              {sortLabel}
              <IconChevronSm className="size-3 rotate-90" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {PULL_SORT_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                selected={option.value === sort}
                className="gap-2"
                onSelect={() => onApplyText(writePullSort(text, option.value))}
              >
                <IconCheck
                  className={cn(
                    'size-3.5',
                    option.value !== sort && 'invisible'
                  )}
                />
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DashboardSectionState
        emptyLabel={getEmptyCopy(request, scope)}
        error={pulls.length === 0 ? error : null}
        isEmpty={pulls.length === 0}
        loading={loading}
        loadingLabel="Loading pull requests…"
        skeleton={<SkeletonRows variant="pull" />}
        onRetry={retry}
      >
        {pulls.map((pull) => (
          <PullRequestRow key={pullKey(pull)} pull={pull} showRepo={showRepo} />
        ))}
      </DashboardSectionState>
      {pulls.length > 0 && error != null && (
        <div className="border-t">
          <SectionError error={error} onRetry={hasMore ? loadMore : retry} />
        </div>
      )}
      {pulls.length > 0 && (hasMore || totalCount > pulls.length) && (
        <div className="text-muted-foreground flex items-center justify-between gap-3 border-t px-3 py-2 text-xs">
          <span className="tabular-nums">
            {pulls.length.toLocaleString()} of {totalCount.toLocaleString()}
          </span>
          {hasMore ? (
            <Button
              variant="outline"
              size="xs"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          ) : (
            // GitHub search stops paging at 1,000 results.
            <span>Narrow the search to see the rest.</span>
          )}
        </div>
      )}
    </section>
  );
}
