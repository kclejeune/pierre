'use client';

import {
  IconCodeSearch,
  IconComment,
  IconFileTree,
  IconFilter,
  IconInfo,
  IconSearch,
  IconXSquircle,
} from '@pierre/icons';
import { FileTree } from '@pierre/trees';
import type { GitStatus } from '@pierre/trees';
import { useFileTreeSearch } from '@pierre/trees/react';
import {
  type CSSProperties,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { revealScrollbarWhileScrolling } from './autoHideScrollbar';
import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import {
  type CommentFilter,
  DiffsHubCommentsList,
  type DiscussionActions,
  type PullDescription,
} from './DiffsHubCommentsList';
import { DiffsHubDiffStats } from './DiffsHubDiffStats';
import { DiffsHubFileTree } from './DiffsHubFileTree';
import { PoweredBy } from './PoweredBy';
import { PANEL_GUTTERED_INSET_CLASS } from './PullDetailsControl';
import { CountChip, SidebarPanelHeader } from './SidebarPanelHeader';
import { StressTestControls } from './StressTestControls';
import { useChromeThemeProps } from './useChromeThemeProps';
import { useMediaQuery } from './useMediaQuery';
import type { StressTestState } from './useStressTest';
import { Button } from '@/components/Button';
import { ButtonGroup, ButtonGroupItem } from '@/components/ButtonGroup';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/DropdownMenu';
import { cn } from '@/lib/cn';
import { MOBILE_MEDIA_QUERY } from '@/lib/constants';
import { filterDiffsHubFileTreeSource } from '@/lib/filterDiffsHubFileTreeSource';
import { getDiffsHubFileTreeAvailableStatuses } from '@/lib/getDiffsHubFileTreeAvailableStatuses';
import { getHiddenTreeItemIds } from '@/lib/getHiddenTreeItemIds';
import { isMacPlatform } from '@/lib/platform';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';
import { getDropdownThemeStyle } from '@/lib/theme/dropdownChromeStyle';
import type {
  DiffsHubDiffStats as DiffsHubDiffStatsData,
  DiffsHubFileTreeSource,
  DiffsHubSavedCommentEntry,
  DiffsHubSavedCommentItem,
  PullDiscussionComment,
} from '@/lib/types';

type SidebarTab = 'files' | 'search' | 'comments' | 'overview';

const HIDDEN_ITEMS_SYNC_DELAY_MS = 150;

interface DiffsHubSidebarProps {
  className?: string;
  commentSections: readonly DiffsHubSavedCommentItem[];
  description?: PullDescription | null;
  diffStats: DiffsHubDiffStatsData | null;
  discussion?: readonly PullDiscussionComment[];
  discussionActions?: DiscussionActions;
  mobileOverlayOpen?: boolean;
  // Called with the ids of files the tree is filtering out (Git-status filter
  // and tree search), so the viewer can collapse them. Empty when nothing is
  // filtered.
  onHiddenItemsChange?(hiddenItemIds: ReadonlySet<string>): void;
  onMobileClose(): void;
  onSelectComment(comment: DiffsHubSavedCommentEntry): void;
  onSelectItem(itemId: string): void;
  // The pull request's overview panel (the header PR chip's popover body),
  // shown in its own tab so it can stay open beside the diff. Omitted outside
  // pull requests or until the pull's details load.
  overviewPanel?: ReactNode;
  // Renders the cross-file search panel; `visible` is whether its tab is the
  // active one. Omitted when the view has no searchable content.
  renderSearchPanel?(visible: boolean): ReactNode;
  // Bumped to switch to the search tab (Ctrl+Shift+F, find usages).
  searchTabRequest?: number;
  // Bumped to open the Comments tab on its Unresolved filter (the
  // overview's Comments cell).
  unresolvedCommentsRequest?: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  source: DiffsHubFileTreeSource;
  streaming: boolean;
  stressTest: StressTestState;
}

export const DiffsHubSidebar = memo(function DiffsHubSidebar({
  className,
  commentSections,
  description,
  diffStats,
  discussion = [],
  discussionActions,
  mobileOverlayOpen = false,
  onHiddenItemsChange,
  onMobileClose,
  onSelectComment,
  onSelectItem,
  overviewPanel,
  renderSearchPanel,
  scrollRef,
  searchTabRequest = 0,
  unresolvedCommentsRequest = 0,
  source,
  streaming,
  stressTest,
}: DiffsHubSidebarProps) {
  const [selectedTab, setSelectedTab] = useState<SidebarTab>('files');
  // The overview tab disappears with its panel (navigating to a compare,
  // say); show the file tree instead of an empty sidebar.
  const activeTab: SidebarTab =
    selectedTab === 'overview' && overviewPanel == null ? 'files' : selectedTab;
  // Tabs other than Files mount the first time they are opened and stay
  // mounted after, so composer drafts, search results, and open pickers
  // survive tab switches. Rendering them from the start — hidden — meant a
  // row, avatar, and deferred-markdown observer per review thread on large
  // PRs before the user ever asked for the list; the comments badge needs
  // only the section totals.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<SidebarTab>>(
    () => new Set(['files'])
  );
  const selectTab = (tab: SidebarTab) => {
    setSelectedTab(tab);
    setVisitedTabs((visited) =>
      visited.has(tab) ? visited : new Set(visited).add(tab)
    );
  };
  // A new search request switches to the search tab during render (React's
  // adjust-state-on-prop-change pattern), so the panel is visible in the
  // same commit that asked for it.
  const [seenSearchTabRequest, setSeenSearchTabRequest] =
    useState(searchTabRequest);
  if (searchTabRequest !== seenSearchTabRequest) {
    setSeenSearchTabRequest(searchTabRequest);
    selectTab('search');
  }
  const [commentFilter, setCommentFilter] = useState<CommentFilter>('all');
  // Starts at 0, not the current value: a request made before the sidebar
  // mounted (a link that opens the diff on its unresolved threads) still
  // applies.
  const [seenCommentsRequest, setSeenCommentsRequest] = useState(0);
  if (unresolvedCommentsRequest !== seenCommentsRequest) {
    setSeenCommentsRequest(unresolvedCommentsRequest);
    setCommentFilter('unresolved');
    selectTab('comments');
  }
  let totalCommentCount = discussion.length;
  for (const section of commentSections) {
    totalCommentCount += section.comments.length;
  }
  // Pull the resolved Shiki theme so the whole sidebar (tabs row, file
  // tree, diff stats panel, footer) sits on the theme's sidebar surface
  // and its chrome text follows the theme's own foreground tokens
  // instead of an opacity-derived fade of the file-tree's muted text.
  // Shared with the header so both chrome surfaces stay in sync.
  const { style: sidebarChromeStyle } = useChromeThemeProps(
    diffshubChromeMapping
  );
  const sidebarStyle =
    Object.keys(sidebarChromeStyle).length > 0 ? sidebarChromeStyle : undefined;
  // Portaled dropdowns (the Git-status filter) render outside the sidebar
  // wrapper, so the chrome variables set on it don't cascade. Re-apply the
  // resolved chrome on the menu surface itself, mirroring the header dropdowns.
  const dropdownThemeStyle = useMemo(
    () => getDropdownThemeStyle(sidebarStyle),
    [sidebarStyle]
  );
  const [diffStatsExpanded, setDiffStatsExpanded] = useState(true);
  const isMobileViewport = useMediaQuery(MOBILE_MEDIA_QUERY, undefined);
  const [previousMobileOverlayOpen, setPreviousMobileOverlayOpen] =
    useState(false);
  const [fileTreeModel, setFileTreeModel] = useState<FileTree | null>(null);
  // Inclusion filter: the statuses the tree should show. Empty means "no
  // filter" — every file is shown — so the menu opens with nothing checked and
  // checking statuses narrows the tree to just those.
  const [selectedStatuses, setSelectedStatuses] = useState<
    ReadonlySet<GitStatus>
  >(() => new Set());
  const availableStatuses = useMemo(
    () => getDiffsHubFileTreeAvailableStatuses(source),
    [source]
  );
  const filteredSource = useMemo(
    () => filterDiffsHubFileTreeSource(source, selectedStatuses),
    [source, selectedStatuses]
  );
  const [searchMatchPaths, setSearchMatchPaths] =
    useState<ReadonlySet<string> | null>(null);
  const hiddenItemIds = useMemo(
    () =>
      getHiddenTreeItemIds(
        source,
        filteredSource,
        selectedStatuses.size > 0,
        searchMatchPaths
      ),
    [source, filteredSource, selectedStatuses, searchMatchPaths]
  );
  // Collapsing thousands of viewer items is far slower than re-filtering the
  // tree, so the viewer catches up once typing in the tree search pauses.
  useEffect(() => {
    if (onHiddenItemsChange == null) {
      return undefined;
    }
    const timeout = window.setTimeout(
      () => onHiddenItemsChange(hiddenItemIds),
      HIDDEN_ITEMS_SYNC_DELAY_MS
    );
    return () => window.clearTimeout(timeout);
  }, [hiddenItemIds, onHiddenItemsChange]);
  const handleModelReady = useCallback((model: FileTree | null) => {
    setFileTreeModel(model);
  }, []);
  const toggleDiffStats = useCallback(() => {
    setDiffStatsExpanded((expanded) => !expanded);
  }, []);

  const clearStatusFilter = useCallback(() => {
    setSelectedStatuses(new Set());
  }, []);

  const toggleSelectedStatus = useCallback((status: GitStatus) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }, []);

  // Alt+click "isolate": narrow the filter to only the clicked status. If it's
  // already the sole selection, clear the filter instead so the tree returns to
  // showing everything.
  const isolateStatus = useCallback((status: GitStatus) => {
    setSelectedStatuses((prev) => {
      if (prev.size === 1 && prev.has(status)) {
        return new Set();
      }
      return new Set([status]);
    });
  }, []);

  // Collapse the diff stats once when a mobile overlay opens, while still
  // allowing the user to reopen them during that same overlay session.
  if (
    isMobileViewport !== undefined &&
    previousMobileOverlayOpen !== mobileOverlayOpen
  ) {
    setPreviousMobileOverlayOpen(mobileOverlayOpen);
    if (mobileOverlayOpen && isMobileViewport) {
      setDiffStatsExpanded(false);
    }
  }

  useEffect(() => {
    if (!mobileOverlayOpen || isMobileViewport !== true) {
      return undefined;
    }

    const { body, documentElement } = document;
    const codeViewScroll = scrollRef.current;
    const previousBodyOverflow = body.style.overflow;
    const previousRootOverscrollBehavior =
      documentElement.style.overscrollBehavior;
    const previousCodeViewOverflow = codeViewScroll?.style.overflow;

    body.style.overflow = 'hidden';
    documentElement.style.overscrollBehavior = 'none';
    if (codeViewScroll != null) {
      codeViewScroll.style.overflow = 'hidden';
    }

    return () => {
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overscrollBehavior = previousRootOverscrollBehavior;
      if (codeViewScroll != null) {
        codeViewScroll.style.overflow = previousCodeViewOverflow ?? '';
      }
    };
  }, [isMobileViewport, mobileOverlayOpen, scrollRef]);

  return (
    <>
      <button
        type="button"
        aria-hidden={!mobileOverlayOpen}
        aria-label="Close file tree"
        tabIndex={mobileOverlayOpen ? 0 : -1}
        className={cn(
          'z-20 cursor-default bg-background/60 backdrop-blur-xs transition-opacity [grid-column:1/-1] [grid-row:1/-1] md:hidden',
          mobileOverlayOpen
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        )}
        onClick={onMobileClose}
      />
      <SidebarWrapper
        className={className}
        mobileOverlayOpen={mobileOverlayOpen}
        themeStyle={sidebarStyle}
      >
        <div className="flex items-center gap-3 px-4 pt-5 pb-2 md:px-3 md:pt-0.5 md:pb-0">
          <ButtonGroup
            aria-label="Sidebar sections"
            className="mr-auto flex min-w-0 gap-3 md:gap-2"
            variant="tabs"
            value={activeTab}
            onValueChange={(value) => selectTab(value as SidebarTab)}
          >
            <ButtonGroupItem
              value="files"
              size="icon-only"
              className="shadow-none"
              title="Files"
            >
              <IconFileTree className="size-4 md:size-3" />
              <span className="sr-only">Files</span>
            </ButtonGroupItem>
            {renderSearchPanel != null && (
              <ButtonGroupItem
                value="search"
                size="icon-only"
                className="shadow-none"
                title="Search all files"
              >
                <IconCodeSearch className="size-4 md:size-3" />
                <span className="sr-only">Search</span>
              </ButtonGroupItem>
            )}
            {/* A rule sets the diff's own tabs (files, search) apart from
                the pull request's, which Details leads; plain diffs have
                only the former. */}
            {overviewPanel != null && (
              <>
                <span
                  aria-hidden="true"
                  className="bg-border h-3.5 w-px self-center"
                />
                <ButtonGroupItem
                  value="overview"
                  size="icon-only"
                  className="shadow-none"
                  title="Pull request details: status, checks, reviewers, and actions"
                >
                  <IconInfo className="size-4 md:size-3" />
                  <span className="sr-only">Pull request details</span>
                </ButtonGroupItem>
              </>
            )}
            <ButtonGroupItem
              value="comments"
              size="icon-only"
              title={
                totalCommentCount > 0
                  ? `Comments (${totalCommentCount})`
                  : 'Comments'
              }
              className={cn(
                'shadow-none',
                // Matches the square tabs' 2px inset on both ends (1px
                // padding inside the 1px border), so every gap in the strip
                // is the same. The icon-to-pill gap matches the panel
                // headers' title-to-count gap (SidebarPanelHeader).
                totalCommentCount > 0 && 'w-auto gap-1.5 px-px'
              )}
            >
              <IconComment className="size-4 md:size-3" />
              <span className="sr-only">Comments</span>
              {totalCommentCount > 0 && (
                <CountChip aria-hidden="true">{totalCommentCount}</CountChip>
              )}
            </ButtonGroupItem>
          </ButtonGroup>
          {onMobileClose != null && (
            <Button
              variant="ghost"
              size="icon-only"
              className={cn(CHROME_ICON_BUTTON_CLASS, 'md:hidden')}
              aria-label="Close file tree"
              onClick={onMobileClose}
            >
              <IconXSquircle className="size-4 md:size-3" />
            </Button>
          )}
        </div>
        <div className="mt-2 min-h-0 flex-1">
          <div
            role="region"
            aria-label="Files"
            hidden={activeTab !== 'files'}
            className="flex h-full min-h-0 flex-col"
          >
            {/* The tree's own tools sit in its title row, like the
                Comments filter, so the tab strip above is only tabs. */}
            <SidebarPanelHeader title="Files" count={diffStats?.fileCount}>
              {fileTreeModel != null && (
                <FileTreeSearchToggle model={fileTreeModel} />
              )}
              {availableStatuses.size > 1 && (
                <FileTreeFilterButton
                  availableStatuses={availableStatuses}
                  selectedStatuses={selectedStatuses}
                  onClear={clearStatusFilter}
                  onToggle={toggleSelectedStatus}
                  onIsolate={isolateStatus}
                  dropdownThemeStyle={dropdownThemeStyle}
                />
              )}
            </SidebarPanelHeader>
            <div className="min-h-0 flex-1">
              <DiffsHubFileTree
                source={filteredSource}
                onModelReady={handleModelReady}
                onSearchMatchesChange={setSearchMatchPaths}
                onSelectItem={onSelectItem}
              />
            </div>
          </div>
          {renderSearchPanel != null && (
            <div
              role="region"
              aria-label="Search"
              hidden={activeTab !== 'search'}
              className="flex h-full min-h-0 flex-col"
            >
              <SidebarPanelHeader title="Search" />
              <div className="min-h-0 flex-1">
                {visitedTabs.has('search') &&
                  renderSearchPanel(activeTab === 'search')}
              </div>
            </div>
          )}
          <div
            role="region"
            aria-label="Comments"
            hidden={activeTab !== 'comments'}
            className="h-full min-h-0"
          >
            {visitedTabs.has('comments') && (
              <DiffsHubCommentsList
                commentSections={commentSections}
                totalCount={totalCommentCount}
                description={description}
                discussion={discussion}
                discussionActions={discussionActions}
                filter={commentFilter}
                onFilterChange={setCommentFilter}
                onSelectComment={onSelectComment}
                onSelectItem={onSelectItem}
              />
            )}
          </div>
          {overviewPanel != null && (
            <div
              role="region"
              aria-label="Overview"
              hidden={activeTab !== 'overview'}
              className="flex h-full min-h-0 flex-col"
            >
              <SidebarPanelHeader title="Pull request" />
              {/* Unpadded scroller, as in PullPreviewPane, so the panel's
                  sticky footer reaches the bottom edge. */}
              <div
                className="cv-autohide-scrollbar min-h-0 flex-1 overflow-y-auto"
                onScroll={revealScrollbarWhileScrolling}
              >
                {visitedTabs.has('overview') && (
                  <div className={cn('pb-3', PANEL_GUTTERED_INSET_CLASS)}>
                    {overviewPanel}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <DiffsHubDiffStats
          expanded={diffStatsExpanded}
          onToggle={toggleDiffStats}
          stats={diffStats}
          streaming={streaming}
        />
        <StressTestControls stressTest={stressTest} />
        <PoweredBy />
      </SidebarWrapper>
    </>
  );
});

interface SidebarWrapperProps {
  children: ReactNode;
  className?: string;
  mobileOverlayOpen: boolean;
  themeStyle?: CSSProperties;
}

function SidebarWrapper({
  children,
  className,
  mobileOverlayOpen,
  themeStyle,
}: SidebarWrapperProps) {
  return (
    <div
      className={cn(
        className,
        'diffshub-theme-bootstrap contain-strict z-30 flex h-full min-h-0 flex-col transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform motion-reduce:transition-none md:z-auto md:translate-y-0 md:will-change-auto',
        // Fall back to the neutral diffshub chrome background when no Shiki
        // theme bg is available yet (initial render before the resolver
        // returns).
        themeStyle == null && 'bg-[var(--diffshub-sidebar-bg)]',
        mobileOverlayOpen
          ? 'pointer-events-auto translate-y-0 overflow-hidden rounded-t-xl shadow-[0_0_0_1px_var(--color-border-opaque),_0_16px_32px_rgb(0_0_0_/0.25)] md:h-full md:overflow-visible md:rounded-none md:border-0 md:shadow-none'
          : 'pointer-events-none translate-y-[calc(100%+1.5rem)] overflow-hidden rounded-xl md:pointer-events-auto md:h-full md:overflow-visible md:rounded-none pt-3 border-r border-[var(--color-border-opaque)]'
      )}
      style={themeStyle}
    >
      {children}
    </div>
  );
}

// Statuses that can appear in a diff, in the order they should appear in the
// filter dropdown. Colors mirror the exact light-dark() values from the tree's
// style.css so the badges match what the tree rows show.
const DIFF_STATUS_ITEMS: {
  status: GitStatus;
  label: string;
  short: string;
  color: string;
}[] = [
  {
    status: 'added',
    label: 'Added',
    short: 'A',
    color: 'light-dark(#16a994, #00cab1)',
  },
  {
    status: 'modified',
    label: 'Modified',
    short: 'M',
    color: 'light-dark(#1ca1c7, #08c0ef)',
  },
  {
    status: 'renamed',
    label: 'Renamed',
    short: 'R',
    color: 'light-dark(#d5a910, #ffd452)',
  },
  {
    status: 'deleted',
    label: 'Deleted',
    short: 'D',
    color: 'light-dark(#ff2e3f, #ff6762)',
  },
];

interface FileTreeFilterButtonProps {
  availableStatuses: ReadonlySet<GitStatus>;
  dropdownThemeStyle?: CSSProperties;
  onClear(): void;
  onIsolate(status: GitStatus): void;
  onToggle(status: GitStatus): void;
  selectedStatuses: ReadonlySet<GitStatus>;
}

function FileTreeFilterButton({
  availableStatuses,
  dropdownThemeStyle,
  onClear,
  onIsolate,
  onToggle,
  selectedStatuses,
}: FileTreeFilterButtonProps) {
  const isFiltered = selectedStatuses.size > 0;
  const visibleItems = DIFF_STATUS_ITEMS.filter(({ status }) =>
    availableStatuses.has(status)
  );
  const [isMac] = useState(isMacPlatform);
  // Track whether Alt was held on the most recent pointer-down so the
  // onCheckedChange handler (which receives no event) can branch on it.
  const altKeyRef = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-only"
          aria-label="Filter by Git status"
          aria-pressed={isFiltered}
          className={cn(CHROME_ICON_BUTTON_CLASS, 'relative')}
        >
          <IconFilter className="size-4 md:size-3" />
          {isFiltered && (
            <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full border-[1px] border-[var(--diffshub-sidebar-bg)] bg-blue-500 dark:bg-blue-400" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="p-2"
        style={dropdownThemeStyle}
      >
        <DropdownMenuLabel className="flex flex-col px-2 font-normal">
          Filter by Git status
          <small className="text-muted-foreground text-xs">
            {isMac ? 'Option' : 'Alt'}-click to show only one status
          </small>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="mx-2" />
        {visibleItems.map(({ status, label, short, color }) => (
          <DropdownMenuCheckboxItem
            key={status}
            checked={selectedStatuses.has(status)}
            indicatorSide="right"
            onPointerDown={(e) => {
              altKeyRef.current = e.altKey;
            }}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => {
              if (altKeyRef.current) {
                onIsolate(status);
              } else {
                onToggle(status);
              }
            }}
            className={
              isFiltered && !selectedStatuses.has(status)
                ? 'text-muted-foreground'
                : ''
            }
          >
            <span
              className="mr-2 w-4 shrink-0 rounded-sm text-center font-mono text-xs font-semibold"
              style={{
                color,
                backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
              }}
            >
              {short}
            </span>
            {label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator className="mx-2" />
        <DropdownMenuItem
          className="px-2"
          disabled={!isFiltered}
          onSelect={onClear}
        >
          <IconXSquircle className="mr-2 opacity-50" />
          Clear filter
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Lives in its own component so we can call useFileTreeSearch only once we
// actually have a model; conditional hook calls aren't allowed in the parent.
function FileTreeSearchToggle({ model }: { model: FileTree }) {
  const search = useFileTreeSearch(model);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-only"
      aria-label={search.isOpen ? 'Hide file search' : 'Show file search'}
      aria-pressed={search.isOpen}
      className={CHROME_ICON_BUTTON_CLASS}
      // Avoid focus moving to this button before click: the tree search input
      // closes on blur, so without preventDefault the blur runs first, then
      // click sees isOpen false and calls open() again.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (search.isOpen) {
          search.close();
        } else {
          search.open();
        }
      }}
    >
      <IconSearch className="size-4 md:size-3" />
    </Button>
  );
}
