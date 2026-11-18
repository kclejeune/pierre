'use client';

import { IconCheck, IconChevronSm, IconEyeSlash, IconPin } from '@pierre/icons';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { revealScrollbarWhileScrolling } from '@/components/autoHideScrollbar';
import { Button } from '@/components/Button';
import { ButtonGroup, ButtonGroupItem } from '@/components/ButtonGroup';
import { openCommandPaletteAtTop } from '@/components/CommandPalette';
import {
  type CommandPaletteContextValue,
  type PaletteRunnableEntry,
  useCommandPaletteContext,
} from '@/components/commandPaletteContext';
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/DropdownMenu';
import { GitHubTokenControl } from '@/components/GitHubTokenControl';
import { PullBatchBar, usePullBatch } from '@/components/PullBatchBar';
import { PullPreviewPane } from '@/components/PullPreviewPane';
import { PullQueryBar } from '@/components/PullQueryBar';
import { PullRequestRow } from '@/components/PullRequestRow';
import { RepoPinStrip, ScopeChip } from '@/components/RepoPinStrip';
import { formatShortcut, useModifierKey } from '@/components/ShortcutHint';
import { Spinner } from '@/components/Spinner';
import { Switch } from '@/components/Switch';
import {
  pullKey,
  type PullSearchRequest,
  useDashboardPulls,
} from '@/components/useDashboardPulls';
import { useGitHubToken } from '@/components/useGitHubToken';
import { useLatestValueRef } from '@/components/useLatestValueRef';
import { useMediaQuery } from '@/components/useMediaQuery';
import { useMutedAuthors } from '@/components/useMutedAuthors';
import { usePinnedRepos } from '@/components/usePinnedRepos';
import { usePullSelection } from '@/components/usePullSelection';
import { cn } from '@/lib/cn';
import { GITHUB_APP_OWNER_FIX } from '@/lib/githubAppAccess';
import {
  involvementsUseReviewRequests,
  normalizePullInvolvements,
  PULL_ACTIVITY_LABELS,
  PULL_INVOLVEMENTS,
  type PullAudience,
  type PullInvolvement,
  type PullSummary,
} from '@/lib/githubPullSummaries';
import {
  authorSearchName,
  isAuthorMuted,
  MAX_MUTED_AUTHORS,
  mutedAuthorLabel,
} from '@/lib/mutedAuthors';
import { isEditableEventTarget } from '@/lib/platform';
import { buildPullRows, groupPulls } from '@/lib/pullGroups';
import { savePullQueue } from '@/lib/pullQueue';
import {
  audienceAnyoneAllowed,
  DEFAULT_QUERY_TEXT,
  defaultAudience,
  type PullScope,
  type PullsPageState,
  readPullsPageState,
  resolveAudience,
  scopeRepos,
  scopesEqual,
  writePullsPageState,
} from '@/lib/pullScopes';
import {
  PULL_SORT_OPTIONS,
  type PullStateFilter,
  readPositiveQualifierValues,
  readPullSort,
  readPullStateFilter,
  writePullAuthorFilter,
  writePullSort,
  writePullStateFilter,
} from '@/lib/pullSearchQuery';
import { recordRecentDiff } from '@/lib/recentDiffs';
import { recordRecentRepo } from '@/lib/recentRepos';

export function PullsDashboard() {
  const tokenState = useGitHubToken();
  const { clearToken, hasToken, hydrated, setToken, tokenVersion } = tokenState;
  const modifier = useModifierKey();
  // The desktop list + preview layout fills the viewport, so the search bar,
  // filters, and state tabs stay put while only the rows (and the preview)
  // scroll.
  const previewLayout = useMediaQuery(PREVIEW_LAYOUT_QUERY, false);
  // Only the signed-in rail + list + preview need the full-width column; the
  // signed-out card keeps the default column so it lines up with the navbar.
  const signedIn = hydrated && hasToken;

  return (
    <DashboardShell
      fillViewport={signedIn && previewLayout}
      section="pulls"
      tokenState={tokenState}
      width={signedIn ? 'full' : 'wide'}
    >
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

// Matches Tailwind's `lg` breakpoint (laptops and up): from here a row click
// previews the pull in a pane beside the list instead of navigating.
const PREVIEW_LAYOUT_QUERY = '(min-width: 64rem)';
// Matches Tailwind's `2xl` breakpoint: from here the scope and involvement
// filters move into a sticky side rail, so the list starts at the top of the
// page instead of under three rows of controls. Below it the rail would
// squeeze the list and preview until titles and metric labels truncate.
const RAIL_LAYOUT_QUERY = '(min-width: 96rem)';

// The list column in the viewport-filling layouts. The list card takes the
// height left under the search bar and filters and scrolls its own rows; when
// a short window leaves it less than its minimum (many wrapped pins, say),
// the whole column scrolls instead, so the rows and "Load more" stay
// reachable even though the page itself never scrolls.
const FILL_COLUMN_CLASS =
  'cv-autohide-scrollbar flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto';

function SignedInDashboard({ tokenVersion }: { tokenVersion: number }) {
  const modifier = useModifierKey();
  const [page, updatePage] = usePullsPageState();
  const { hydrated, pinned, toggle } = usePinnedRepos();
  const mutedAuthors = useMutedAuthors();
  // This view renders only after hydration (below), so the client value is
  // the first one painted.
  const previewLayout = useMediaQuery(PREVIEW_LAYOUT_QUERY, false);
  const railLayout = useMediaQuery(RAIL_LAYOUT_QUERY, false);
  const orientation = railLayout ? 'vertical' : 'horizontal';
  // The pull shown in the preview pane. Kept as the row's summary (not just
  // its key) so the pane stays put while the list refetches or filters
  // change around it.
  const [preview, setPreview] = useState<PullSummary | null>(null);
  // Bumped when the preview pane changed a pull, so the list refetches.
  const [listVersion, setListVersion] = useState(0);
  // The list's rows on screen, kept current by PullList. Opening a diff from
  // the list or the preview saves them as the diff view's queue
  // (lib/pullQueue), so the diff can step to the next pull.
  const queueRef = useRef<readonly PullSummary[]>([]);
  const openDiff = useCallback((pull: PullSummary) => {
    recordRecentDiff({ path: pull.viewerPath, title: pull.title });
    savePullQueue(
      queueRef.current.map((entry) => ({
        path: entry.viewerPath,
        title: entry.title,
      }))
    );
  }, []);

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
  usePullsPaletteContext(pinned.length, selectScope, page.text, applyText);

  // Wait for the single post-mount pin read: the pinned scope searches the
  // pinned list, and fetching before it loads would search everything.
  // The muted list loads the same way, and searching before it does would
  // flash the bots it hides.
  if (!hydrated || !mutedAuthors.hydrated) {
    return null;
  }

  const involves = resolveAudience(page);
  const repos = scopeRepos(page.scope, pinned);
  // Only searches with a review-request term carry the switch's value, so
  // flipping it doesn't refetch (or re-key the cache for) the others.
  const usesReviewRequests =
    involves !== 'anyone' && involvementsUseReviewRequests(involves);
  const request: PullSearchRequest = {
    involves,
    mutedAuthors: page.showMuted ? undefined : mutedAuthors.muted,
    repos,
    reviewRequests: usesReviewRequests ? page.reviewRequests : undefined,
    text: page.text,
  };

  const queryBar = (
    <PullQueryBar
      appliedText={page.text}
      scope={page.scope}
      onApply={applyText}
      onOpenScope={openCommandPaletteAtTop}
    />
  );
  const scopeNav = (
    <RepoPinStrip
      ariaLabel="Repository scopes"
      orientation={orientation}
      pinned={pinned}
      selectedRepo={page.scope.kind === 'repo' ? page.scope.repo : null}
      leading={
        <BroadScopeChips
          orientation={orientation}
          pinnedCount={pinned.length}
          scope={page.scope}
          onSelect={selectScope}
        />
      }
      onAddPin={openCommandPaletteAtTop}
      onSelectRepo={(repo) => selectScope({ kind: 'repo', repo })}
      onTogglePin={toggle}
    />
  );
  const audienceFilter = (
    <AudienceFilter
      anyoneAllowed={audienceAnyoneAllowed(page.scope, page.text)}
      orientation={orientation}
      value={involves}
      onChange={(next) => updatePage({ ...page, involves: next })}
    />
  );
  const teamToggle = usesReviewRequests && (
    <label
      className={cn(
        'text-muted-foreground flex cursor-pointer items-center gap-2 text-xs',
        railLayout && 'justify-between px-2'
      )}
      title="Also count review requests sent to teams you're on"
    >
      Team requests
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
  );
  const list =
    page.scope.kind === 'pinned' && pinned.length === 0 ? (
      <div className={cn(SECTION_CARD_CLASS, 'px-4 py-6 text-sm')}>
        <p className="font-medium">No pinned repositories yet.</p>
        <p className="text-muted-foreground mt-1">
          Press {formatShortcut(modifier, 'K')}, find a repository, and press{' '}
          {formatShortcut(modifier, '↵')} to pin it. Pinned repositories appear
          {railLayout ? ' at the left' : ' above'} for one-click switching, and
          this view searches all of them at once.
        </p>
      </div>
    ) : (
      <PullList
        fill={previewLayout}
        listVersion={listVersion}
        muting={{
          muted: mutedAuthors.muted,
          showMuted: page.showMuted,
          onMute: mutedAuthors.mute,
          onShowMutedChange: (showMuted) => updatePage({ ...page, showMuted }),
          onUnmute: mutedAuthors.unmute,
        }}
        request={request}
        scope={page.scope}
        selectedKey={preview == null ? null : pullKey(preview)}
        tokenVersion={tokenVersion}
        onApplyText={applyText}
        onClosePreview={() => setPreview(null)}
        onOpen={openDiff}
        onPreview={previewLayout ? setPreview : undefined}
        queueRef={queueRef}
      />
    );
  const previewPane = previewLayout && (
    <PullPreviewPane
      muted={mutedAuthors.muted}
      pull={preview}
      tokenVersion={tokenVersion}
      onClose={() => setPreview(null)}
      onMute={mutedAuthors.mute}
      onOpenDiff={openDiff}
      onPullChanged={() => setListVersion((value) => value + 1)}
    />
  );

  // Columns: [rail] list, preview. The pane is always present in the wide
  // layouts (empty until a row is picked) so selecting a pull never reflows
  // the list under the pointer. Two-line rows gain nothing past ~900px, so
  // extra width goes to the preview: 0.8x the list's share on laptops, an
  // even split with the rail, and 1.3x from 120rem, where the pane is wide
  // enough for its description-plus-sidebar layout. The floor keeps the
  // overview's metric bars legible.
  if (railLayout) {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)_minmax(26rem,1fr)] grid-rows-[minmax(0,1fr)] gap-8 min-[120rem]:grid-cols-[15rem_minmax(0,1fr)_minmax(26rem,1.3fr)]">
        <aside
          aria-label="Pull request filters"
          className="cv-autohide-scrollbar min-h-0 space-y-5 overflow-y-auto"
          onScroll={revealScrollbarWhileScrolling}
        >
          <RailSection heading="Repositories">{scopeNav}</RailSection>
          <RailSection heading="Involvement">
            {audienceFilter}
            {teamToggle}
          </RailSection>
        </aside>
        <div
          className={FILL_COLUMN_CLASS}
          onScroll={revealScrollbarWhileScrolling}
        >
          {queryBar}
          {list}
        </div>
        {previewPane}
      </div>
    );
  }
  const stacked = (
    <div
      className={previewLayout ? FILL_COLUMN_CLASS : 'min-w-0 space-y-3'}
      onScroll={previewLayout ? revealScrollbarWhileScrolling : undefined}
    >
      {queryBar}
      {scopeNav}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-1">
        {audienceFilter}
        {teamToggle}
      </div>
      {list}
    </div>
  );
  if (previewLayout) {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(24rem,0.8fr)] grid-rows-[minmax(0,1fr)] gap-6">
        {stacked}
        {previewPane}
      </div>
    );
  }
  return stacked;
}

// A titled group in the wide layout's filter rail.
function RailSection({
  children,
  heading,
}: {
  children: ReactNode;
  heading: string;
}) {
  return (
    <section className="space-y-1.5">
      <h2 className="text-muted-foreground px-2 text-xs font-medium">
        {heading}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

// Tells the command palette that picking a repository here scopes the list
// to it, offers the broad scopes first, and adds the state toggle and sort
// menu as commands. The callbacks are read through refs so the context
// object only changes when the pin count or the search text does.
function usePullsPaletteContext(
  pinnedCount: number,
  selectScope: (scope: PullScope) => void,
  text: string,
  applyText: (text: string) => void
) {
  const select = useLatestValueRef(selectScope);
  const apply = useLatestValueRef(applyText);
  const context = useMemo((): CommandPaletteContextValue => {
    const state = readPullStateFilter(text);
    const sort = readPullSort(text);
    const commands: PaletteRunnableEntry[] = [
      ...STATE_TOGGLES.filter((option) => option.value !== state).map(
        (option): PaletteRunnableEntry => ({
          id: `state-${option.value}`,
          label:
            option.value === 'all'
              ? 'Show pull requests in every state'
              : `Show ${option.label.toLowerCase()} pull requests`,
          keywords: 'state filter open closed merged',
          run: () => apply.current(writePullStateFilter(text, option.value)),
        })
      ),
      ...PULL_SORT_OPTIONS.filter((option) => option.value !== sort).map(
        (option): PaletteRunnableEntry => ({
          id: `sort-${option.value}`,
          label: `Sort: ${option.label}`,
          keywords: 'sort order',
          run: () => apply.current(writePullSort(text, option.value)),
        })
      ),
    ];
    const scopes: PaletteRunnableEntry[] = [
      {
        id: 'scope-all',
        label: 'All repositories',
        detail: 'Pull requests involving you, anywhere',
        icon: 'scope-all',
        run: () => select.current({ kind: 'all' }),
      },
    ];
    if (pinnedCount > 0) {
      scopes.push({
        id: 'scope-pinned',
        label: 'Pinned repositories',
        detail:
          pinnedCount === 1 ? '1 repository' : `${pinnedCount} repositories`,
        icon: 'scope-pinned',
        run: () => select.current({ kind: 'pinned' }),
      });
    }
    return {
      commands,
      onSelectRepo: (repo) => select.current({ kind: 'repo', repo }),
      scopes,
      selectRepoLabel: 'View pull requests',
    };
  }, [apply, pinnedCount, select, text]);
  useCommandPaletteContext(context);
}

// The strip's leading chips: every repository, then every pinned one at
// once, before the individual pins.
function BroadScopeChips({
  onSelect,
  orientation,
  pinnedCount,
  scope,
}: {
  onSelect(scope: PullScope): void;
  orientation: 'horizontal' | 'vertical';
  pinnedCount: number;
  scope: PullScope;
}) {
  return (
    <>
      <ScopeChip
        fill={orientation === 'vertical'}
        selected={scope.kind === 'all'}
        onClick={() => onSelect({ kind: 'all' })}
      >
        All
      </ScopeChip>
      {pinnedCount > 0 && (
        <ScopeChip
          fill={orientation === 'vertical'}
          selected={scope.kind === 'pinned'}
          title={`Search all ${pinnedCount} pinned repositories`}
          onClick={() => onSelect({ kind: 'pinned' })}
        >
          <IconPin className="size-3" />
          Pinned
          <span className="text-muted-foreground tabular-nums">
            {pinnedCount}
          </span>
        </ScopeChip>
      )}
      <span
        aria-hidden="true"
        className={cn(
          'bg-border',
          orientation === 'vertical' ? 'mx-2 my-1 h-px' : 'mx-1 h-4 w-px'
        )}
      />
    </>
  );
}

// Who the list is about. "Anyone" (no involvement terms) is offered once the
// search is narrowed to some repositories; "Involves me" is the OR of every
// involvement; the remaining chips multi-select into a narrower OR, folding
// back into "Involves me" when all are selected.
function AudienceFilter({
  anyoneAllowed,
  onChange,
  orientation,
  value,
}: {
  anyoneAllowed: boolean;
  onChange(next: PullAudience): void;
  orientation: 'horizontal' | 'vertical';
  value: PullAudience;
}) {
  const vertical = orientation === 'vertical';
  // Rail rows read as a nav list (left-aligned, filled when selected, like
  // the repository rows above them) rather than a vertical segmented control.
  const itemClassName = (isSelected: boolean) =>
    vertical
      ? cn(
          'w-full justify-start',
          isSelected &&
            'bg-accent dark:bg-accent border-transparent font-medium shadow-none'
        )
      : // Slightly tighter than the sm default so the team-requests switch
        // fits on the same row at laptop widths.
        'px-2.5';
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
      className={
        vertical
          ? 'w-full flex-col gap-0.5 self-stretch bg-transparent'
          : 'flex-wrap'
      }
      size="sm"
    >
      {anyoneAllowed && (
        <ButtonGroupItem
          className={itemClassName(value === 'anyone')}
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
        className={itemClassName(value !== 'anyone' && value.length === 0)}
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
          className={itemClassName(selected.includes(involvement))}
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

// An empty list whose search did match pulls, so the matches seen are in
// repos the viewer's GitHub App sign-in can't read. With pages left, only
// the ones checked so far are; readable pulls may still follow.
export function getUnreadableCopy(
  totalCount: number,
  hasMore: boolean
): string {
  if (hasMore) {
    return `The pull requests checked so far are in repositories the DiffsHub GitHub App can't read. Load more to keep looking.`;
  }
  const matches =
    totalCount === 1
      ? '1 pull request matches'
      : `${totalCount.toLocaleString()} pull requests match`;
  return `${matches}, but the DiffsHub GitHub App can't read the repositories they're in. ${GITHUB_APP_OWNER_FIX}`;
}

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
  fill,
  listVersion,
  muting,
  onApplyText,
  onClosePreview,
  onOpen,
  onPreview,
  queueRef,
  request,
  scope,
  selectedKey,
  tokenVersion,
}: {
  // Fill the column's remaining height: the header and footer stay fixed
  // and only the rows scroll (the desktop layout).
  fill: boolean;
  // Bumped by the parent to refetch after a pull changed elsewhere.
  listVersion: number;
  muting: MutingControls;
  onApplyText(text: string): void;
  onClosePreview(): void;
  // Opening a pull's diff from this list (see SignedInDashboard's openDiff).
  onOpen(pull: PullSummary): void;
  // Set in the wide layout: plain row clicks preview instead of navigating.
  onPreview?(pull: PullSummary): void;
  // Receives the rows on screen, which openDiff saves as the diff view's
  // queue.
  queueRef: RefObject<readonly PullSummary[]>;
  request: PullSearchRequest;
  scope: PullScope;
  selectedKey: string | null;
  tokenVersion: number;
}) {
  const { text } = request;
  const {
    error,
    hasMore,
    loadMore,
    loading,
    loadingMore,
    mutedCount,
    pulls,
    refresh,
    retry,
    searchKey,
    totalCount,
  } = useDashboardPulls(request, tokenVersion);
  const state = readPullStateFilter(text);
  const sort = readPullSort(text);
  const sortLabel =
    PULL_SORT_OPTIONS.find((option) => option.value === sort)?.label ??
    `sort:${sort}`;
  const showRepo = scope.kind !== 'repo';
  // The muted authors whose rows dim while muted pulls are shown, lowercased
  // once so each row's check is a set lookup. An author the query asks for
  // (author:x, e.g. from "Show only their pull requests") isn't excluded by
  // the search, so their rows show at full strength.
  const mutedNames = useMemo(() => {
    const requested = new Set(
      readPositiveQualifierValues(text, 'author').map((name) =>
        name.toLowerCase()
      )
    );
    return new Set(
      muting.muted
        .map((author) => author.toLowerCase())
        .filter((author) => !requested.has(author))
    );
  }, [muting.muted, text]);
  // Near-duplicate pulls (same title and author) fold into one row until
  // expanded; `rows` is what's on screen, which J/K walk and the diff
  // view's queue follows.
  const groups = useMemo(() => groupPulls(pulls), [pulls]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const rows = useMemo(
    () => buildPullRows(groups, expanded),
    [expanded, groups]
  );
  const visible = useMemo(() => rows.map((row) => row.pull), [rows]);
  useEffect(() => {
    queueRef.current = visible;
  }, [queueRef, visible]);
  // The search a running batch started from: its failures return to the
  // selection only if the list still shows that search.
  const batchSearch = useRef<string | null>(null);
  const batch = usePullBatch((failed, changed) => {
    selection.set(failed, batchSearch.current ?? undefined);
    if (changed) {
      refresh();
    }
  });
  const selection = usePullSelection(
    pulls,
    rows,
    searchKey,
    batch.running != null
  );
  const toggleGroup = useCallback(
    (key: string) =>
      setExpanded((previous) => {
        const next = new Set(previous);
        if (!next.delete(key)) {
          next.add(key);
        }
        return next;
      }),
    []
  );
  // Refetch, past the browser cache, when the parent says a pull changed;
  // skip the mount run, which the hook's own first fetch covers.
  const refreshRef = useLatestValueRef(refresh);
  const seenListVersion = useRef(listVersion);
  useEffect(() => {
    if (seenListVersion.current !== listVersion) {
      seenListVersion.current = listVersion;
      refreshRef.current();
    }
  }, [listVersion, refreshRef]);
  usePreviewKeyboard(visible, selectedKey, {
    onClosePreview,
    onOpen,
    onPreview,
    onToggleChecked: selection.toggleRow,
  });
  return (
    <section
      aria-busy={loading}
      aria-label="Pull requests"
      // min-h-64 keeps the rows reachable on short windows: past it, the
      // column scrolls instead of squeezing the list (FILL_COLUMN_CLASS).
      className={cn(
        SECTION_CARD_CLASS,
        fill && 'flex min-h-64 flex-1 flex-col'
      )}
    >
      <div className="bg-muted/30 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2 py-1.5">
        {selection.checked.length > 0 || batch.running != null ? (
          <PullBatchBar
            checked={selection.checked}
            loadedCount={pulls.length}
            running={batch.running}
            onClear={selection.clear}
            onRun={(action) => {
              batchSearch.current = searchKey;
              batch.run(action, selection.checked);
            }}
            onSelectAll={() => selection.set(pulls)}
          />
        ) : (
          <>
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
                  {state === option.value &&
                    (loading ? (
                      // Refetching: the count and any rows below are the
                      // previous answer until the search returns.
                      <Spinner className="text-muted-foreground ml-1.5 inline size-3 align-[-1px]" />
                    ) : (
                      <span className="text-muted-foreground ml-1.5 font-normal tabular-nums">
                        {totalCount.toLocaleString()}
                      </span>
                    ))}
                </button>
              ))}
            </div>
            <MutedAuthorsMenu
              muting={muting}
              mutedCount={mutedCount}
              pulls={pulls}
              text={text}
              onApplyText={onApplyText}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground h-7"
                >
                  {sortLabel}
                  <IconChevronSm className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {PULL_SORT_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    selected={option.value === sort}
                    className="gap-2"
                    onSelect={() =>
                      onApplyText(writePullSort(text, option.value))
                    }
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
          </>
        )}
      </div>
      {/* No scrollbar on the pinned list: a styled scrollbar always takes
          layout space in Chromium, and its reserved gutter left every row
          short of the card's right edge. Wheel, trackpad, J/K (which scroll
          the active row into view), and "Load more" still move through it. */}
      <div
        className={
          fill
            ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
            : undefined
        }
      >
        <DashboardSectionState
          emptyLabel={
            totalCount > 0
              ? getUnreadableCopy(totalCount, hasMore)
              : getEmptyCopy(request, scope)
          }
          error={pulls.length === 0 ? error : null}
          isEmpty={pulls.length === 0}
          loading={loading}
          loadingLabel="Loading pull requests…"
          skeleton={<SkeletonRows variant="pull" />}
          onRetry={retry}
        >
          {rows.map((row) => (
            <PullRequestRow
              key={pullKey(row.pull)}
              checked={selection.isRowChecked(row)}
              groupExpanded={expanded.has(row.group.key)}
              groupKey={row.lead ? row.group.key : undefined}
              groupSize={row.group.pulls.length}
              muted={muting.showMuted && mutedNames.has(authorKey(row.pull))}
              nested={!row.lead}
              pull={row.pull}
              selected={selectedKey === pullKey(row.pull)}
              selecting={selection.checked.length > 0}
              selectionLocked={batch.running != null}
              showRepo={showRepo}
              onOpen={onOpen}
              onPreview={onPreview}
              onToggleChecked={selection.toggleRow}
              onToggleGroup={toggleGroup}
            />
          ))}
        </DashboardSectionState>
        {pulls.length > 0 && error != null && (
          <div className="border-t">
            <SectionError error={error} onRetry={retry} />
          </div>
        )}
      </div>
      {/* An empty page can still have more: its hits were all unreadable. */}
      {(pulls.length > 0 || hasMore) &&
        (hasMore || totalCount > pulls.length) && (
          <div className="text-muted-foreground flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2 text-xs">
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

// Keyboard control of the preview selection, active only in the wide layout
// (`onPreview` set): J/K (or the arrow keys) move through the loaded rows,
// Enter opens the focused row's diff (or the selected pull's, when no
// control has focus) in a new tab, X checks or unchecks the previewed row
// for the batch bar, and Escape closes the preview. Keys
// typed into fields, or already handled by an open menu or dialog, are left
// alone.
function usePreviewKeyboard(
  pulls: readonly PullSummary[],
  selectedKey: string | null,
  handlers: {
    onClosePreview(): void;
    onOpen(pull: PullSummary): void;
    onPreview?(pull: PullSummary): void;
    onToggleChecked(key: string, shiftKey: boolean): void;
  }
) {
  const latest = useLatestValueRef({ ...handlers, pulls, selectedKey });
  const enabled = handlers.onPreview != null;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableEventTarget(event) ||
        document.querySelector('[role="dialog"], [role="menu"]') != null
      ) {
        return;
      }
      const {
        onClosePreview,
        onOpen,
        onPreview,
        onToggleChecked,
        pulls,
        selectedKey,
      } = latest.current;
      const index = pulls.findIndex((pull) => pullKey(pull) === selectedKey);
      if (event.key === 'x' && index !== -1) {
        event.preventDefault();
        onToggleChecked(pullKey(pulls[index]), false);
        return;
      }
      const step =
        event.key === 'j' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'k' || event.key === 'ArrowUp'
            ? -1
            : 0;
      if (step !== 0 && onPreview != null && pulls.length > 0) {
        event.preventDefault();
        const next =
          pulls[
            index === -1
              ? 0
              : Math.min(pulls.length - 1, Math.max(0, index + step))
          ];
        onPreview(next);
        return;
      }
      if (event.key === 'Enter') {
        // A focused pull row: open its diff. Its native activation would be
        // a click, which the row turns into a preview, so cancel that and
        // navigate here.
        const row =
          event.target instanceof HTMLAnchorElement &&
          event.target.matches('[data-pull-row]')
            ? event.target
            : null;
        const pull =
          row != null
            ? pulls.find(
                (candidate) => candidate.viewerPath === row.getAttribute('href')
              )
            : // Focus on no control (the page body, as after J/K from a
              // click elsewhere): open the selected pull. Any focused
              // control, from links to a description's <summary>, keeps its
              // native Enter.
              event.target === document.body
              ? pulls[index]
              : undefined;
        if (pull != null) {
          event.preventDefault();
          onOpen(pull);
          // A new tab, like the preview's Open diff button, so the list
          // stays where it was as a queue to come back to.
          window.open(pull.viewerPath, '_blank', 'noopener');
          return;
        }
      }
      if (event.key === 'Escape' && selectedKey != null) {
        onClosePreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, latest]);

  // Keeps the selected row on screen as J/K move past the viewport edge, and
  // moves focus with the selection when focus was already on a row, so the
  // focus ring and the selection highlight never mark two different rows.
  useEffect(() => {
    if (selectedKey == null) {
      return;
    }
    const row = document.querySelector<HTMLElement>(
      '[data-pull-row][aria-current="true"]'
    );
    row?.scrollIntoView({ block: 'nearest' });
    if (
      row != null &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement.matches('[data-pull-row]')
    ) {
      row.focus({ preventScroll: true });
    }
  }, [selectedKey]);
}

// The muted-author list and its controls, handed from the page (which owns
// the list and the ?muted= switch) to the list card's Muted menu.
interface MutingControls {
  muted: readonly string[];
  // Muted authors' pulls are listed (dimmed) instead of excluded.
  showMuted: boolean;
  onMute(authors: readonly string[]): void;
  onShowMutedChange(showMuted: boolean): void;
  onUnmute(author: string): void;
}

// The lowercased author search name rows are matched against muted
// authors by ('' for an authorless pull, which nothing mutes).
function authorKey(pull: PullSummary): string {
  return (authorSearchName(pull) ?? '').toLowerCase();
}

// Bot authors among the loaded rows that aren't muted yet, in list order:
// the Muted menu offers them as one-click mutes, so the common case (bumps
// from renovate or dependabot burying everything) needs no typing.
function unmutedBotAuthors(
  pulls: readonly PullSummary[],
  muted: readonly string[]
): string[] {
  const authors: string[] = [];
  for (const pull of pulls) {
    const author = authorSearchName(pull);
    if (
      pull.authorIsBot === true &&
      author != null &&
      !isAuthorMuted(muted, author) &&
      !isAuthorMuted(authors, author)
    ) {
      authors.push(author);
    }
  }
  return authors;
}

// The list header's Muted menu: how many pulls muted authors hid, a switch
// to list them anyway, each muted author (narrow the search to them, which
// is how to triage a bot's pulls in one place, or unmute), and the bots in
// view that could be muted. Hidden when nothing is muted and no bot is in
// view; the preview pane's mute button covers people and machine accounts.
function MutedAuthorsMenu({
  muting,
  mutedCount,
  onApplyText,
  pulls,
  text,
}: {
  muting: MutingControls;
  mutedCount: number | undefined;
  onApplyText(text: string): void;
  pulls: readonly PullSummary[];
  text: string;
}) {
  const { muted, showMuted } = muting;
  const bots = useMemo(() => unmutedBotAuthors(pulls, muted), [muted, pulls]);
  const room = MAX_MUTED_AUTHORS - muted.length;
  if (muted.length === 0 && bots.length === 0) {
    return null;
  }
  const triggerLabel =
    muted.length === 0
      ? 'Mute bots'
      : showMuted
        ? 'Showing muted'
        : mutedCount != null && mutedCount > 0
          ? // Counts pulls, not authors: "63 muted pulls" from one bot.
            `${mutedCount.toLocaleString()} muted ${mutedCount === 1 ? 'pull' : 'pulls'}`
          : 'Muted';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground ml-auto h-7 tabular-nums"
          title="Authors whose pull requests this list leaves out"
        >
          <IconEyeSlash className="size-3" />
          {triggerLabel}
          <IconChevronSm className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {muted.length > 0 && (
          <>
            <DropdownMenuCheckboxItem
              checked={showMuted}
              onCheckedChange={(checked) =>
                muting.onShowMutedChange(checked === true)
              }
            >
              Show muted authors&apos; pulls
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Muted authors
            </DropdownMenuLabel>
            {muted.map((author) => (
              <DropdownMenuSub key={author}>
                <DropdownMenuSubTrigger>
                  {mutedAuthorLabel(author)}
                  {author.startsWith('app/') && (
                    <span className="text-muted-foreground text-xs">bot</span>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    onSelect={() =>
                      onApplyText(writePullAuthorFilter(text, author))
                    }
                  >
                    Show only their pull requests
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => muting.onUnmute(author)}>
                    Unmute
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </>
        )}
        {bots.length > 0 && room > 0 && (
          <>
            {muted.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Bots in this list
            </DropdownMenuLabel>
            {bots.length > 1 && (
              <DropdownMenuItem
                onSelect={() => muting.onMute(bots.slice(0, room))}
              >
                Mute all {Math.min(bots.length, room)}
              </DropdownMenuItem>
            )}
            {bots.map((author) => (
              <DropdownMenuItem
                key={author}
                onSelect={() => muting.onMute([author])}
              >
                Mute {mutedAuthorLabel(author)}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
