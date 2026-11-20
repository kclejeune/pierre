'use client';

import { IconCheck, IconChevronSm, IconEyeSlash, IconPin } from '@pierre/icons';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  use,
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
  DropdownMenuBareRadioItem,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/DropdownMenu';
import { useGitHubEnvironment } from '@/components/GitHubEnvironmentProvider';
import { GitHubTokenControl } from '@/components/GitHubTokenControl';
import { PullBatchBar, usePullBatch } from '@/components/PullBatchBar';
import { PullFilterMenus } from '@/components/PullFilterMenus';
import {
  prefetchPullPreview,
  PullPreviewPane,
} from '@/components/PullPreviewPane';
import { PullQueryBar } from '@/components/PullQueryBar';
import { PullQueueIdContext } from '@/components/PullQueueLinkContext';
import { PullQuickLook } from '@/components/PullQuickLook';
import { PullRequestRow } from '@/components/PullRequestRow';
import { muteWithUndo, type PullRowAction } from '@/components/PullRowActions';
import { RepoPinStrip, ScopeChip } from '@/components/RepoPinStrip';
import { formatShortcut, useModifierKey } from '@/components/ShortcutHint';
import { Spinner } from '@/components/Spinner';
import { Switch } from '@/components/Switch';
import {
  type PullSearchRequest,
  useDashboardPulls,
} from '@/components/useDashboardPulls';
import { useGitHubToken } from '@/components/useGitHubToken';
import { useLatestValueRef } from '@/components/useLatestValueRef';
import { useMediaQuery } from '@/components/useMediaQuery';
import { useMutedAuthors } from '@/components/useMutedAuthors';
import { useMuteRules } from '@/components/useMuteRules';
import { usePinnedRepos } from '@/components/usePinnedRepos';
import { usePullSelection } from '@/components/usePullSelection';
import { usePullStatuses } from '@/components/usePullStatuses';
import { cn } from '@/lib/cn';
import { GITHUB_APP_OWNER_FIX } from '@/lib/githubAppAccess';
import {
  effectiveMutedAuthors,
  effectiveMutedBranches,
  involvementsUseReviewRequests,
  normalizePullInvolvements,
  PULL_ACTIVITY_LABELS,
  PULL_INVOLVEMENTS,
  type PullAudience,
  type PullInvolvement,
  pullKey,
  type PullSummary,
  staleMutingApplies,
} from '@/lib/githubPullSummaries';
import {
  authorSearchName,
  isAuthorMuted,
  MAX_MUTED_AUTHORS,
  mutedAuthorLabel,
} from '@/lib/mutedAuthors';
import {
  type BranchMutePreset,
  describeStaleDuration,
  formatStaleDuration,
  isBranchMuted,
  isLikelyBotAuthor,
  isValidBranchPrefix,
  matchesMutedBranch,
  MAX_MUTED_BRANCHES,
  parseStaleDuration,
  resolveStaleAfter,
  staleCutoff,
  type StaleDuration,
} from '@/lib/muteRules';
import { isPageShortcutEvent } from '@/lib/platform';
import { PrefetchGroup } from '@/lib/prefetchStore';
import { buildPullRows, groupPulls } from '@/lib/pullGroups';
import {
  pullQueueId,
  type PullQueueItem,
  savePullQueue,
  withPullQueue,
} from '@/lib/pullQueue';
import {
  audienceAnyoneAllowed,
  DEFAULT_QUERY_TEXT,
  defaultAudience,
  type MutedView,
  type PullScope,
  type PullsPageState,
  readPreviewPullKey,
  readPullsPageState,
  resolveAudience,
  scopeRepos,
  scopesEqual,
  writePreviewPull,
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
import { recordRecentDiff } from '@/lib/recentDiffs';
import { recordRecentRepo } from '@/lib/recentRepos';

// How long the preview rests on a pull before its neighbors are prefetched.
const NEIGHBOR_PREFETCH_DELAY_MS = 150;

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

// The pull shown in the preview pane, mirrored into ?pull= so a refresh
// reopens it. Kept as the row's summary (not just its key) so the pane stays
// put while the list refetches or filters change around it; that summary is
// why a reload can't restore the preview on its own. Instead the key read
// from the URL waits for the list: the returned restore callback (fed every
// fetched pull, including ones folded into a collapsed group) previews the
// matching pull once it appears. If the list finishes loading without it
// (say it was on a later page) the pane stays closed and the URL is left
// for the next selection to replace. Back and Forward restore the key their
// entry names the same way. Any explicit selection, including closing the
// pane, supersedes a pending restore.
function usePersistedPreview() {
  const [preview, setPreviewState] = useState<PullSummary | null>(null);
  const pendingKey = useRef(readPreviewPullKey(window.location.search));
  // The fetched pulls last fed to `restorePreview`, so a history entry can
  // restore its preview from the list already on screen.
  const lastPulls = useRef<readonly PullSummary[]>([]);
  const setPreview = useCallback((pull: PullSummary | null) => {
    pendingKey.current = null;
    setPreviewState(pull);
    window.history.replaceState(
      window.history.state,
      '',
      writePreviewPull(new URL(window.location.href), pull)
    );
  }, []);
  // Previews the pending key's pull if `pulls` has it; the URL already
  // names it, so only the state changes.
  const matchPending = useCallback((pulls: readonly PullSummary[]) => {
    const key = pendingKey.current;
    const match =
      key == null ? undefined : pulls.find((pull) => pullKey(pull) === key);
    if (match != null) {
      pendingKey.current = null;
      setPreviewState(match);
    }
    return match != null;
  }, []);
  const restorePreview = useCallback(
    (pulls: readonly PullSummary[], loading: boolean) => {
      lastPulls.current = pulls;
      if (!matchPending(pulls) && !loading) {
        pendingKey.current = null;
      }
    },
    [matchPending]
  );
  useEffect(() => {
    const onPopState = () => {
      const key = readPreviewPullKey(window.location.search);
      setPreviewState((current) =>
        current != null && pullKey(current) === key ? current : null
      );
      pendingKey.current = key;
      // The entry's list may already be on screen; otherwise its rows
      // restore the preview once they load.
      matchPending(lastPulls.current);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [matchPending]);
  return [preview, setPreview, restorePreview] as const;
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
  const muteRules = useMuteRules();
  const { muting: mutingConfig } = useGitHubEnvironment();
  // This view renders only after hydration (below), so the client value is
  // the first one painted.
  const previewLayout = useMediaQuery(PREVIEW_LAYOUT_QUERY, false);
  const railLayout = useMediaQuery(RAIL_LAYOUT_QUERY, false);
  const orientation = railLayout ? 'vertical' : 'horizontal';
  const [preview, setPreview, restorePreview] = usePersistedPreview();
  // The quick look (components/PullQuickLook) over the list, showing the
  // previewed pull's diff: its place among the list's rows, or null while
  // closed. index -1 means the pull isn't among the rows on screen.
  const [quickLook, setQuickLook] = useState<{
    index: number;
    total: number;
  } | null>(null);
  // Bumped when the preview pane changed a pull, so the list refetches.
  const [listVersion, setListVersion] = useState(0);
  // The list's rows on screen, kept current by PullList (J/K, the quick
  // look, and opening a diff read them at event time).
  const queueRef = useRef<readonly PullSummary[]>([]);
  // The id of those rows as the diff view's queue (lib/pullQueue). It goes
  // on every diff link from this list as ?queue= (PullQueueIdContext), and
  // opening a diff saves the rows under it, with the /pulls URL they came
  // from, so the diff can step through them and lead back to these filters.
  // State only changes when the rows do, so a refetch that returns the same
  // rows doesn't re-render them.
  const [queueId, setQueueId] = useState(() => pullQueueId([]));
  const queueIdRef = useLatestValueRef(queueId);
  // Whether the list is loading with no rows on screen yet, kept current by
  // PullList. Hover and J/K prefetches wait it out, so the list search
  // doesn't queue behind preview requests for the same token
  // (lib/githubFetch); once rows show (cached, or a stale page being
  // revalidated) the viewer can act on them, so prefetching resumes.
  const listWaitingRef = useRef(false);
  const openDiff = useCallback(
    (pull: PullSummary) => {
      recordRecentDiff({ path: pull.viewerPath, title: pull.title });
      // The way back previews the pull that was opened.
      const list = writePreviewPull(new URL(window.location.href), pull);
      // Saved under the id the rows' links already carry.
      savePullQueue(queueIdRef.current, {
        items: toQueueItems(queueRef.current),
        listPath: `${list.pathname}${list.search}`,
      });
    },
    [queueIdRef]
  );
  const onRowsChange = useCallback(
    (
      rows: readonly PullSummary[],
      fetched: readonly PullSummary[],
      loading: boolean
    ) => {
      queueRef.current = rows;
      // The list's filters (its URL without the previewed pull) are part of
      // the id, so a different filter showing the same rows gets its own.
      const list = writePreviewPull(new URL(window.location.href), null);
      setQueueId(
        pullQueueId(toQueueItems(rows), `${list.pathname}${list.search}`)
      );
      restorePreview(fetched, loading);
    },
    [restorePreview]
  );

  // J/K move the preview one row at a time, so the rows on either side of
  // the previewed pull are the likeliest next selections: their data is
  // prefetched once the preview settles (lib/prefetchStore). The settle
  // delay skips rows a held J only passes through, and the pull the
  // preview just left is skipped, since the pane already loaded it.
  const lastPreviewKey = useRef<string | null>(null);
  // One prefetch group per neighbor pull, so moving on cancels only the
  // pulls that are neither a neighbor any more nor the one now previewed.
  // Cancelling the previewed pull's group would abort the requests the
  // pane is about to take (its details wait on its info's head commit).
  const neighborPrefetches = useRef(new Map<string, PrefetchGroup>());
  useEffect(() => {
    const groups = neighborPrefetches.current;
    return () => {
      for (const group of groups.values()) {
        group.cancel();
      }
      groups.clear();
    };
  }, []);
  useEffect(() => {
    const cameFrom = lastPreviewKey.current;
    lastPreviewKey.current = preview == null ? null : pullKey(preview);
    if (preview == null) {
      return;
    }
    const timer = setTimeout(() => {
      if (listWaitingRef.current) {
        return;
      }
      const rows = queueRef.current;
      const index = rows.findIndex((row) => pullKey(row) === pullKey(preview));
      if (index === -1) {
        return;
      }
      // Settling on a new row abandons the old neighbors' requests that
      // nothing took. Not done in the effect's cleanup, which runs before
      // the preview pane's own effects take the pull it just moved to.
      const neighbors = [rows[index + 1], rows[index - 1]].filter(
        (neighbor): neighbor is PullSummary =>
          neighbor != null && pullKey(neighbor) !== cameFrom
      );
      const keep = new Set([pullKey(preview), ...neighbors.map(pullKey)]);
      const groups = neighborPrefetches.current;
      for (const [key, group] of groups) {
        if (!keep.has(key)) {
          group.cancel();
          groups.delete(key);
        }
      }
      for (const neighbor of neighbors) {
        const key = pullKey(neighbor);
        if (!groups.has(key)) {
          const group = new PrefetchGroup();
          groups.set(key, group);
          prefetchPullPreview(neighbor, group);
        }
      }
    }, NEIGHBOR_PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [preview]);

  // Opens the quick look on `pull`, which also becomes the previewed pull
  // (the list's selection follows the quick look as it steps).
  const openQuickLook = useCallback((pull: PullSummary) => {
    const rows = queueRef.current;
    setPreview(pull);
    setQuickLook({
      index: rows.findIndex((row) => pullKey(row) === pullKey(pull)),
      total: rows.length,
    });
  }, []);
  // J/K in the quick look: the neighboring row, like J/K in the list. The
  // previewed pull is found by key at step time, since a refetch or an
  // expanded group can move it after the quick look opened.
  const stepQuickLook = useCallback(
    (delta: -1 | 1) => {
      const rows = queueRef.current;
      const index =
        preview == null
          ? -1
          : rows.findIndex((row) => pullKey(row) === pullKey(preview));
      const next = index === -1 ? undefined : rows[index + delta];
      if (next != null) {
        openQuickLook(next);
      }
    },
    [openQuickLook, preview]
  );

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
  if (!hydrated || !mutedAuthors.hydrated || !muteRules.hydrated) {
    return null;
  }
  const staleAfter = resolveStaleAfter(
    muteRules.rules,
    mutingConfig.defaultStaleAfter
  );

  const involves = resolveAudience(page);
  const repos = scopeRepos(page.scope, pinned);
  // Only searches with a review-request term carry the switch's value, so
  // flipping it doesn't refetch (or re-key the cache for) the others.
  const usesReviewRequests =
    involves !== 'anyone' && involvementsUseReviewRequests(involves);
  // Showing muted pulls (dimmed) sends no mute rules at all; listing only
  // them sends the rules to match instead of exclude.
  const showMuted = page.mutedView === 'show';
  const request: PullSearchRequest = {
    involves,
    mutedAuthors: showMuted ? undefined : mutedAuthors.muted,
    mutedBranches: showMuted ? undefined : muteRules.rules.branches,
    mutedOnly: page.mutedView === 'only',
    repos,
    reviewRequests: usesReviewRequests ? page.reviewRequests : undefined,
    staleAfter:
      showMuted || staleAfter == null
        ? undefined
        : formatStaleDuration(staleAfter),
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
  const list = (
    <PullQueueIdContext value={queueId}>
      {page.scope.kind === 'pinned' && pinned.length === 0 ? (
        <div className={cn(SECTION_CARD_CLASS, 'px-4 py-6 text-sm')}>
          <p className="font-medium">No pinned repositories yet.</p>
          <p className="text-muted-foreground mt-1">
            Press {formatShortcut(modifier, 'K')}, find a repository, and press{' '}
            {formatShortcut(modifier, '↵')} to pin it. Pinned repositories
            appear
            {railLayout ? ' at the left' : ' above'} for one-click switching,
            and this view searches all of them at once.
          </p>
        </div>
      ) : (
        <PullList
          fill={previewLayout}
          listVersion={listVersion}
          muting={{
            botLoginPatterns: mutingConfig.botLoginPatterns,
            branches: muteRules.rules.branches,
            branchPresets: mutingConfig.branchPresets,
            defaultStaleAfter: mutingConfig.defaultStaleAfter,
            full: mutedAuthors.muted.length >= MAX_MUTED_AUTHORS,
            muted: mutedAuthors.muted,
            mutedView: page.mutedView,
            staleAfter,
            staleAfterPicked: muteRules.rules.staleAfter != null,
            onMute: mutedAuthors.mute,
            onMuteBranch: muteRules.muteBranch,
            onSetStaleAfter: muteRules.setStaleAfter,
            onMutedViewChange: (mutedView) =>
              updatePage({ ...page, mutedView }),
            onUnmute: mutedAuthors.unmute,
            onUnmuteBranch: muteRules.unmuteBranch,
          }}
          request={request}
          scope={page.scope}
          selectedKey={preview == null ? null : pullKey(preview)}
          tokenVersion={tokenVersion}
          onApplyText={applyText}
          onClosePreview={() => setPreview(null)}
          onOpen={openDiff}
          onPreview={previewLayout ? setPreview : undefined}
          onQuickLook={previewLayout ? openQuickLook : undefined}
          listWaitingRef={listWaitingRef}
          onRowsChange={onRowsChange}
        />
      )}
    </PullQueueIdContext>
  );
  // The quick look renders with the preview pane: both exist only in the
  // wide layout, and the dialog portals over the whole page anyway.
  const previewPane = previewLayout && (
    <PullQueueIdContext value={queueId}>
      <PullPreviewPane
        muted={mutedAuthors.muted}
        pull={preview}
        tokenVersion={tokenVersion}
        onClose={() => setPreview(null)}
        onMute={mutedAuthors.mute}
        onOpenDiff={openDiff}
        onPullChanged={() => setListVersion((value) => value + 1)}
        onQuickLook={openQuickLook}
      />
      {quickLook != null && preview != null && (
        <PullQuickLook
          position={quickLook.index === -1 ? null : quickLook}
          pull={preview}
          onClose={() => setQuickLook(null)}
          onOpenReview={openDiff}
          onStep={stepQuickLook}
        />
      )}
    </PullQueueIdContext>
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
      : // Slightly tighter than the sm default so more chips fit a row.
        // Unselected chips keep a transparent border so selecting one
        // doesn't shift its neighbors.
        cn('px-2.5', !isSelected && 'border border-transparent');
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
      // Inline, the involvements are separate chips rather than one
      // segmented tray: they toggle independently, and a tray that wraps
      // reads as a ragged block, where chips wrap into clean rows.
      className={
        vertical
          ? 'w-full flex-col gap-0.5 self-stretch bg-transparent'
          : 'flex-wrap gap-1 bg-transparent'
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
  onQuickLook,
  onRowsChange,
  listWaitingRef,
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
  // Space on the previewed row opens the quick look (wide layout only).
  onQuickLook?(pull: PullSummary): void;
  // Told the rows on screen, every fetched pull (rows plus those folded into
  // collapsed groups), and whether the search is still loading, each time
  // any changes: the parent keeps the rows as the diff view's queue and
  // restores the previewed pull after a reload.
  onRowsChange(
    rows: readonly PullSummary[],
    fetched: readonly PullSummary[],
    loading: boolean
  ): void;
  // Set while the list loads with no rows yet; prefetches skip until then.
  listWaitingRef: RefObject<boolean>;
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
    pulls: listedPulls,
    refresh,
    retry,
    searchKey,
    totalCount,
  } = useDashboardPulls(request, tokenVersion);
  // The rows with their CI and review state, which load after the list
  // (components/usePullStatuses); `statusPending` rows hold the glyph's place.
  const { pending: statusPending, pulls } = usePullStatuses(
    listedPulls,
    tokenVersion
  );
  // The hovered row's prefetches (components/PullRequestRow waits for the
  // pointer to rest first). Hovering another row aborts the requests the
  // preview didn't take, so only the latest row's keep running, except
  // when the last hovered row is the one now previewed: the pane is still
  // taking its requests.
  const hoverPrefetch = useRef<{ group: PrefetchGroup; key: string } | null>(
    null
  );
  const selectedKeyRef = useLatestValueRef(selectedKey);
  useEffect(() => () => hoverPrefetch.current?.group.cancel(), []);
  const listWaiting = loading && listedPulls.length === 0;
  useEffect(() => {
    listWaitingRef.current = listWaiting;
  }, [listWaitingRef, listWaiting]);
  const prefetchHovered = useCallback(
    (pull: PullSummary) => {
      if (listWaitingRef.current) {
        return;
      }
      const previous = hoverPrefetch.current;
      if (previous != null && previous.key !== selectedKeyRef.current) {
        previous.group.cancel();
      }
      const group = new PrefetchGroup();
      hoverPrefetch.current = { group, key: pullKey(pull) };
      prefetchPullPreview(pull, group);
    },
    [listWaitingRef, selectedKeyRef]
  );
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
  const mutedNames = useMemo(
    () =>
      new Set(
        effectiveMutedAuthors(muting.muted, text).map((author) =>
          author.toLowerCase()
        )
      ),
    [muting.muted, text]
  );
  // What else dims a row while muted pulls are shown: a muted branch, or no
  // update since the staleness cutoff (when the search would hide stale
  // pulls). ISO timestamps compare as strings, and a date-only cutoff sorts
  // before every time on its own day.
  const dimmedBranches = useMemo(
    () => effectiveMutedBranches(muting.branches, text),
    [muting.branches, text]
  );
  // Tokenizes the query, so it runs per search rather than per render (the
  // list re-renders on every selection step).
  const staleApplies = useMemo(() => staleMutingApplies(text), [text]);
  const dimBefore =
    muting.staleAfter != null && staleApplies
      ? // oxlint-disable-next-line react/purity -- the cutoff is rounded to the hour or day (staleCutoff), so reading the clock per render only moves it when the search's own cutoff would move too.
        staleCutoff(muting.staleAfter, new Date())
      : undefined;
  const isRowMuted = (pull: PullSummary) =>
    mutedNames.has(authorKey(pull)) ||
    matchesMutedBranch(dimmedBranches, pull.headRefName) ||
    (dimBefore != null && pull.updatedAt < dimBefore);
  // Every muted author, for the rows' mute buttons: unlike mutedNames, it
  // includes an author the query names, who is still muted.
  const allMutedNames = useMemo(
    () => new Set(muting.muted.map((author) => author.toLowerCase())),
    [muting.muted]
  );
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
    onRowsChange(visible, pulls, loading);
  }, [onRowsChange, visible, pulls, loading]);
  // The search a running batch started from: its failures return to the
  // selection only if the list still shows that search.
  const batchSearch = useRef<string | null>(null);
  const batch = usePullBatch(({ changed, failed, origin }) => {
    // A row action's failure is reported on its own; it doesn't check rows.
    if (origin === 'selection') {
      selection.set(failed, batchSearch.current ?? undefined);
    }
    if (changed) {
      refresh();
    }
  });
  // The rows' "⋯" menus. Approve and merge run as one-pull batches (the
  // batch bar's same head-pinned actions, toasts, and refetch); mute and
  // unmute edit the muted list, and muting offers an Undo since the row
  // leaves the list. Read through refs so the callback stays stable and the
  // memoized rows don't re-render whenever `muting` or the batch rebuilds.
  const mutingRef = useLatestValueRef(muting);
  const batchRef = useLatestValueRef(batch);
  const onOpenRef = useLatestValueRef(onOpen);
  const onRowAction = useCallback(
    (pull: PullSummary, action: PullRowAction) => {
      if (action === 'approve' || action === 'merge') {
        batchRef.current.run(action, [pull], 'row');
        return;
      }
      if (action === 'open') {
        onOpenRef.current(pull);
        return;
      }
      const author = authorSearchName(pull);
      if (author == null) {
        return;
      }
      const controls = mutingRef.current;
      if (action === 'unmute') {
        controls.onUnmute(author);
        return;
      }
      muteWithUndo(author, controls.onMute, (name) =>
        mutingRef.current.onUnmute(name)
      );
    },
    [batchRef, mutingRef, onOpenRef]
  );
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
    onQuickLook,
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
      <div className="bg-muted/30 @container/header flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2 py-1.5">
        {selection.checked.length > 0 || batch.running != null ? (
          <PullBatchBar
            allLoadedChecked={selection.allLoadedChecked}
            checked={selection.checked}
            loadedCount={pulls.length}
            running={batch.running}
            onClear={selection.clear}
            onRun={(action) => {
              batchSearch.current = searchKey;
              batch.run(action, selection.checked);
            }}
            // Adds every loaded pull, keeping pulls checked from earlier
            // pages (a batch's failures) selected.
            onSelectAll={() => selection.set([...selection.checked, ...pulls])}
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
            <PullFilterMenus
              muting={muting}
              pulls={pulls}
              text={text}
              onApplyText={onApplyText}
            />
            <MuteMenu
              muting={muting}
              mutedCount={mutedCount}
              pulls={pulls}
              text={text}
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
              muted={muting.mutedView === 'show' && isRowMuted(row.pull)}
              actionsBusy={batch.running != null}
              authorMuted={allMutedNames.has(authorKey(row.pull))}
              muteFull={muting.full}
              nested={!row.lead}
              pull={row.pull}
              statusPending={statusPending.has(pullKey(row.pull))}
              selected={selectedKey === pullKey(row.pull)}
              selecting={selection.checked.length > 0}
              selectionLocked={batch.running != null}
              showRepo={showRepo}
              onOpen={onOpen}
              onPrefetch={onPreview == null ? undefined : prefetchHovered}
              onPreview={onPreview}
              onToggleChecked={selection.toggleRow}
              onRowAction={onRowAction}
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
    onQuickLook?(pull: PullSummary): void;
    onToggleChecked(key: string, shiftKey: boolean): void;
  }
) {
  // Diffs opened with Enter carry the list's ?queue=, like the row links.
  const queueId = use(PullQueueIdContext);
  const latest = useLatestValueRef({
    ...handlers,
    pulls,
    queueId,
    selectedKey,
  });
  const enabled = handlers.onPreview != null;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPageShortcutEvent(event)) {
        return;
      }
      const {
        onClosePreview,
        onOpen,
        onPreview,
        onQuickLook,
        onToggleChecked,
        pulls,
        queueId,
        selectedKey,
      } = latest.current;
      const index = pulls.findIndex((pull) => pullKey(pull) === selectedKey);
      // Space: a quick look at the previewed pull's diff, like Finder's. Only
      // with focus on the page or a pull row, so a focused button or
      // <summary> keeps its own Space.
      if (
        event.key === ' ' &&
        index !== -1 &&
        onQuickLook != null &&
        (event.target === document.body ||
          (event.target instanceof HTMLElement &&
            event.target.matches('[data-pull-row]')))
      ) {
        event.preventDefault();
        onQuickLook(pulls[index]);
        return;
      }
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
                (candidate) =>
                  candidate.viewerPath === new URL(row.href).pathname
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
          window.open(
            withPullQueue(pull.viewerPath, queueId),
            '_blank',
            'noopener'
          );
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

// The list's muting state and controls, handed from the page (which owns
// the muted authors, the mute rules, and the ?muted= switch) to the list
// card's Muted menu and its rows.
interface MutingControls {
  // Login globs that mark machine users as bots (deployment config).
  botLoginPatterns: readonly string[];
  // Muted head-branch prefixes (lib/muteRules).
  branches: readonly string[];
  // The deployment's one-click branch mutes.
  branchPresets: readonly BranchMutePreset[];
  // The deployment's staleness default, as a duration ("60d", "off").
  defaultStaleAfter: string;
  // The muted list is at MAX_MUTED_AUTHORS, so no one else can be muted.
  full: boolean;
  muted: readonly string[];
  // Muted pulls are left out, listed dimmed, or the only ones listed.
  mutedView: MutedView;
  // How long an open pull can go without an update and still be listed;
  // undefined when stale pulls aren't hidden.
  staleAfter: StaleDuration | undefined;
  // The viewer picked their own staleness rather than the default.
  staleAfterPicked: boolean;
  onMute(authors: readonly string[]): void;
  onMuteBranch(prefix: string): void;
  // A duration or "off"; undefined returns to the deployment default.
  onSetStaleAfter(value: string | undefined): void;
  onMutedViewChange(mutedView: MutedView): void;
  onUnmute(author: string): void;
  onUnmuteBranch(prefix: string): void;
}

// A list's rows as diff-view queue entries (lib/pullQueue).
function toQueueItems(rows: readonly PullSummary[]): PullQueueItem[] {
  return rows.map((row) => ({ path: row.viewerPath, title: row.title }));
}

// The lowercased author search name rows are matched against muted
// authors by ('' for an authorless pull, which nothing mutes).
function authorKey(pull: PullSummary): string {
  return (authorSearchName(pull) ?? '').toLowerCase();
}

// Bot authors among the loaded rows that aren't muted yet, in list order:
// GitHub App bots and machine users whose logins match the deployment's bot
// patterns (renovate-bot, release_bot). The Muted menu offers them as
// one-click mutes, so the common case (bumps burying everything) needs no
// typing.
function unmutedBotAuthors(
  pulls: readonly PullSummary[],
  muted: readonly string[],
  patterns: readonly string[]
): string[] {
  const authors: string[] = [];
  for (const pull of pulls) {
    const author = authorSearchName(pull);
    if (
      author != null &&
      isLikelyBotAuthor(pull, patterns) &&
      !isAuthorMuted(muted, author) &&
      !isAuthorMuted(authors, author)
    ) {
      authors.push(author);
    }
  }
  return authors;
}

// One choice in the Muted menu's segmented rows: its label, the longer
// description shown on hover, and the value it picks.
interface MenuSegment<T extends string> {
  label: string;
  title: string;
  value: T;
}

// The Muted menu's choices for what the list does with muted pulls.
const MUTED_VIEW_OPTIONS: readonly MenuSegment<MutedView>[] = [
  { label: 'Hide', title: 'Leave muted pulls out', value: 'hide' },
  {
    label: 'Show dimmed',
    title: 'List muted pulls along with the rest, dimmed',
    value: 'show',
  },
  {
    label: 'Only muted',
    title: 'List only muted pulls, e.g. to approve bot pulls in a batch',
    value: 'only',
  },
];

// The staleness choices the Muted menu offers as one click; any other
// duration can be typed.
const STALE_OPTIONS: readonly MenuSegment<string>[] = [
  { label: '1w', title: 'Hide open pulls not updated in 1 week', value: '1w' },
  {
    label: '30d',
    title: 'Hide open pulls not updated in 30 days',
    value: '30d',
  },
  {
    label: '60d',
    title: 'Hide open pulls not updated in 60 days',
    value: '60d',
  },
  {
    label: '90d',
    title: 'Hide open pulls not updated in 90 days',
    value: '90d',
  },
  {
    label: '6mo',
    title: 'Hide open pulls not updated in 6 months',
    value: '6mo',
  },
  { label: 'Off', title: 'Keep stale pulls listed', value: 'off' },
];

// A segmented row of exclusive choices inside the Muted menu: equal-width
// segments filling the menu on the shared ButtonGroup track. Each segment is
// also a menu radio item, so arrow keys reach it like the rest of the menu
// (which traps Tab), and choosing one keeps the menu open. A value that
// matches no segment (a typed duration) leaves every segment unpicked.
function MenuSegments<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange(value: T): void;
  options: readonly MenuSegment<T>[];
  value: string;
}) {
  return (
    <DropdownMenuRadioGroup
      asChild
      value={value}
      onValueChange={(next) => {
        const picked = options.find((option) => option.value === next);
        if (picked != null) {
          onChange(picked.value);
        }
      }}
    >
      <ButtonGroup
        aria-label={label}
        className="w-full self-stretch border p-0.5"
        size="xs"
        value={value}
      >
        {options.map((option) => (
          <DropdownMenuBareRadioItem
            key={option.value}
            asChild
            value={option.value}
            onSelect={(event) => event.preventDefault()}
          >
            <ButtonGroupItem
              className="data-[highlighted]:ring-ring h-6 flex-1 px-1.5 tabular-nums outline-none data-[highlighted]:ring-2"
              title={option.title}
              value={option.value}
            >
              {option.label}
            </ButtonGroupItem>
          </DropdownMenuBareRadioItem>
        ))}
      </ButtonGroup>
    </DropdownMenuRadioGroup>
  );
}

// The list header's Muted menu: how many pulls muting hid, whether the list
// hides muted pulls, shows them dimmed, or shows only them, the staleness
// cutoff, branch mutes (the deployment's
// presets and the viewer's own prefixes), and a shortcut to mute the bots in
// view. Muting and unmuting individual authors happens where they're seen:
// the rows' mute buttons and the Author filter menu, which also lists who is
// muted.
function MuteMenu({
  muting,
  mutedCount,
  pulls,
  text,
}: {
  muting: MutingControls;
  mutedCount: number | undefined;
  pulls: readonly PullSummary[];
  text: string;
}) {
  const { branches, branchPresets, muted, mutedView, staleAfter } = muting;
  const bots = useMemo(
    () => unmutedBotAuthors(pulls, muted, muting.botLoginPatterns),
    [muted, muting.botLoginPatterns, pulls]
  );
  const room = MAX_MUTED_AUTHORS - muted.length;
  const customBranches = branches.filter(
    (prefix) =>
      !branchPresets.some((preset) => isBranchMuted([preset.prefix], prefix))
  );
  const staleValue =
    staleAfter == null ? 'off' : formatStaleDuration(staleAfter);
  const defaultStale = parseStaleDuration(muting.defaultStaleAfter);
  const triggerLabel =
    mutedView === 'show'
      ? 'Showing muted'
      : mutedView === 'only'
        ? 'Only muted'
        : mutedCount != null && mutedCount > 0
          ? // Counts pulls, not rules: "63 muted pulls" from one bot.
            `${mutedCount.toLocaleString()} muted ${mutedCount === 1 ? 'pull' : 'pulls'}`
          : 'Muted';
  // Shift-click range selection over the branch items (presets, then the
  // viewer's own prefixes), as on the pull rows: shift-clicking an item sets
  // every item between it and the last one clicked to the clicked item's new
  // state. Radix's onCheckedChange carries no event, so the shift key is
  // read on pointer and key down.
  const branchAnchor = useRef<string | null>(null);
  const branchShift = useRef(false);
  const branchOrder = [
    ...branchPresets.map((preset) => preset.prefix),
    ...customBranches,
  ];
  const toggleBranches = (prefix: string, mute: boolean) => {
    const anchor = branchShift.current ? branchAnchor.current : null;
    const from = anchor == null ? -1 : branchOrder.indexOf(anchor);
    const to = branchOrder.indexOf(prefix);
    const range =
      from === -1 || to === -1
        ? [prefix]
        : branchOrder.slice(Math.min(from, to), Math.max(from, to) + 1);
    for (const each of range) {
      if (mute) {
        muting.onMuteBranch(each);
      } else {
        muting.onUnmuteBranch(each);
      }
    }
    branchAnchor.current = prefix;
  };
  const branchItemProps = (prefix: string, checked: boolean) => ({
    onPointerDown: (event: { shiftKey: boolean }) => {
      branchShift.current = event.shiftKey;
    },
    onKeyDown: (event: { shiftKey: boolean }) => {
      branchShift.current = event.shiftKey;
    },
    onSelect: (event: Event) => event.preventDefault(),
    onCheckedChange: () => toggleBranches(prefix, !checked),
  });
  const stopTypeahead = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Keep typing inside the field instead of triggering the menu's
    // typeahead or item activation.
    event.stopPropagation();
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground h-7 tabular-nums"
          title="What this list leaves out: muted authors and branches, and stale pulls"
        >
          <IconEyeSlash className="size-3" />
          {triggerLabel}
          <IconChevronSm className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Muted pulls
        </DropdownMenuLabel>
        <div className="px-2 pb-2">
          <MenuSegments
            label="Muted pulls"
            options={MUTED_VIEW_OPTIONS}
            value={mutedView}
            onChange={muting.onMutedViewChange}
          />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Hide open pulls not updated in
          {!staleMutingApplies(text) && staleAfter != null && (
            <span className="block">
              (not applied: this search filters or sorts by update time, or
              isn&apos;t limited to open pulls)
            </span>
          )}
        </DropdownMenuLabel>
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          <MenuSegments
            label="Hide open pulls not updated in"
            options={STALE_OPTIONS}
            value={staleValue}
            onChange={muting.onSetStaleAfter}
          />
          <StaleDurationInput
            key={staleValue}
            value={staleValue}
            onKeyDown={stopTypeahead}
            onCommit={muting.onSetStaleAfter}
          />
        </div>
        {muting.staleAfterPicked && defaultStale != null && (
          <DropdownMenuItem
            className="text-muted-foreground text-xs"
            onSelect={() => muting.onSetStaleAfter(undefined)}
          >
            Use the default (
            {defaultStale === 'off'
              ? 'off'
              : describeStaleDuration(defaultStale)}
            )
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Branches
        </DropdownMenuLabel>
        {branchPresets.map((preset) => {
          const checked = isBranchMuted(branches, preset.prefix);
          return (
            <DropdownMenuCheckboxItem
              key={preset.prefix}
              checked={checked}
              disabled={!checked && branches.length >= MAX_MUTED_BRANCHES}
              {...branchItemProps(preset.prefix, checked)}
            >
              <span className="flex-1">{preset.label}</span>
              <span className="text-muted-foreground font-mono text-xs">
                {preset.prefix}*
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
        {customBranches.map((prefix) => (
          <DropdownMenuCheckboxItem
            key={prefix}
            checked
            {...branchItemProps(prefix, true)}
          >
            <span className="font-mono text-xs">{prefix}*</span>
          </DropdownMenuCheckboxItem>
        ))}
        {branches.length < MAX_MUTED_BRANCHES && (
          <div className="px-2 pt-0.5 pb-1.5">
            <BranchPrefixInput
              onKeyDown={stopTypeahead}
              onAdd={muting.onMuteBranch}
            />
          </div>
        )}
        {bots.length > 0 && room > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Bots in this list
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => muting.onMute(bots.slice(0, room))}
            >
              {bots.length === 1
                ? `Mute ${mutedAuthorLabel(bots[0])}`
                : `Mute all ${Math.min(bots.length, room)} bots`}
            </DropdownMenuItem>
          </>
        )}
        {muted.length > 0 && (
          <DropdownMenuLabel className="text-muted-foreground border-t text-xs font-normal">
            {muted.length} muted {muted.length === 1 ? 'author' : 'authors'},
            listed in the Author filter
          </DropdownMenuLabel>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The Muted menu's typed staleness: any duration parseStaleDuration reads
// ("36h", "2 weeks", "3mo", "off"), applied on Enter or blur. An unreadable
// entry stays in the field, outlined, until it's fixed or the menu closes.
function StaleDurationInput({
  onCommit,
  onKeyDown,
  value,
}: {
  onCommit(value: string): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const valid = parseStaleDuration(draft) != null;
  const commit = () => {
    if (valid && draft.trim() !== value) {
      onCommit(draft);
    }
  };
  return (
    <input
      aria-label="Hide open pulls not updated in (a duration like 36h, 2w, or 3mo)"
      value={draft}
      placeholder="Any duration, e.g. 36h, 2w, 3mo"
      spellCheck={false}
      className={cn(
        'h-7 w-full rounded-md border bg-transparent px-2 font-mono text-xs focus:outline-none',
        !valid && 'border-destructive'
      )}
      onChange={({ currentTarget }) => setDraft(currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        onKeyDown(event);
        if (event.key === 'Enter') {
          commit();
        }
      }}
    />
  );
}

// The Muted menu's field for muting another branch prefix, added on Enter.
function BranchPrefixInput({
  onAdd,
  onKeyDown,
}: {
  onAdd(prefix: string): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void;
}) {
  const [draft, setDraft] = useState('');
  const prefix = draft.trim();
  const valid = prefix === '' || isValidBranchPrefix(prefix);
  return (
    <input
      aria-label="Mute pulls from branches starting with"
      value={draft}
      placeholder="Branch prefix, e.g. release/"
      spellCheck={false}
      className={cn(
        'h-7 w-full rounded-md border bg-transparent px-2 font-mono text-xs focus:outline-none',
        !valid && 'border-destructive'
      )}
      onChange={({ currentTarget }) => setDraft(currentTarget.value)}
      onKeyDown={(event) => {
        onKeyDown(event);
        if (event.key === 'Enter' && prefix !== '' && valid) {
          onAdd(prefix);
          setDraft('');
        }
      }}
    />
  );
}
