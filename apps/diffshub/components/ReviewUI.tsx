'use client';

import { type DiffIndicators } from '@pierre/diffs';
import { type CodeViewHandle } from '@pierre/diffs/react';
import { type ColorMode } from '@pierre/theming';
import { useThemeController } from '@pierre/theming/react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { DiffFindBar } from './DiffFindBar';
import type { DiscussionActions } from './DiffsHubCommentsList';
import { DiffsHubHeader } from './DiffsHubHeader';
import { DiffsHubSidebar } from './DiffsHubSidebar';
import { DiffsHubStatusPanel } from './DiffsHubStatusPanel';
import { DiffsHubViewer } from './DiffsHubViewer';
import { FileSearchPalette } from './FileSearchPalette';
import { PullCommitPanel } from './PullCommitPanel';
import { PullCommitRangePicker } from './PullCommitRangePicker';
import {
  PullConflictControl,
  PullConflictResolver,
} from './PullConflictResolver';
import { PullDetailsControl } from './PullDetailsControl';
import { ReviewSubmitControl } from './ReviewSubmitControl';
import { ThemeSourceProvider } from './ThemeSourceProvider';
import { useDiffSearchController } from './useDiffSearchController';
import { useDiffSearchUI } from './useDiffSearchUI';
import { useGitHubDiffFileLoader } from './useGitHubDiffFileLoader';
import { useGitHubToken } from './useGitHubToken';
import { useIsHydrated } from './useIsHydrated';
import { usePatchLoader } from './usePatchLoader';
import { usePendingReviewComments } from './usePendingReviewComments';
import { usePullEditSession } from './usePullEditSession';
import { usePullInfo } from './usePullInfo';
import { usePullReviewThreads } from './usePullReviewThreads';
import { useStressTest } from './useStressTest';
import {
  docsThemeCatalog,
  themeController,
} from '@/components/themeController';
import {
  compileCollapsePatterns,
  loadCollapsePatternsText,
  parseCollapsePatterns,
  saveCollapsePatternsText,
} from '@/lib/collapsePatterns';
import { MOBILE_MEDIA_QUERY } from '@/lib/constants';
import { describeDiffRefs, formatDiffSourceShorthand } from '@/lib/diffRefs';
import {
  DEFAULT_DISPLAY_SETTINGS,
  loadDisplaySettings,
  updateDisplaySettings,
} from '@/lib/displaySettings';
import { parseGitHubDiffSource } from '@/lib/githubDiffSource';
import { incrementItemVersion } from '@/lib/incrementItemVersion';
import { isDiffItem } from '@/lib/isDiffItem';
import { getOpenDocDiff } from '@/lib/isDocAnnotation';
import { onPreferencesRestored } from '@/lib/preferenceSync';
import {
  createCommentAnchor,
  deletePullDiscussionComment,
  editPullDiscussionComment,
  postPullDiscussionComment,
  type PullRequestRef,
  type PullReviewDraftComment,
  type PullReviewEvent,
  submitPullReview,
} from '@/lib/pullCommentsClient';
import {
  fetchPullConflicts,
  type PullConflictsResult,
} from '@/lib/pullConflictsClient';
import { recordRecentDiff } from '@/lib/recentDiffs';
import { removeSavedCommentSidebarEntry } from '@/lib/removeSavedCommentSidebarEntry';
import { docCommentTarget } from '@/lib/renderedDocDom';
import { buildDiffHeadTreePath } from '@/lib/repoBrowser';
import {
  chooseReviewCommit,
  describeStaleReviewEntries,
} from '@/lib/reviewCommit';
import { scrollDocTargetIntoView } from '@/lib/scrollDocTargetIntoView';
import type { DarkThemeName, LightThemeName } from '@/lib/themeNames';
import { toastRequestError } from '@/lib/toastRequestError';
import type {
  CommentMetadata,
  DiffsHubDeletedCommentEvent,
  DiffsHubSavedCommentEntry,
  DiffsHubSavedCommentEvent,
  PullDiscussionComment,
} from '@/lib/types';
import { upsertSavedCommentSidebarEntry } from '@/lib/upsertSavedCommentSidebarEntry';

interface ReviewUIProps {
  domain?: string;
  initialUrl: string;
  path: string;
  returnToPullPath?: string;
}

export function ReviewUI({
  domain,
  initialUrl,
  path,
  returnToPullPath,
}: ReviewUIProps) {
  // Provide the diffshub-scoped theme context, then render the body BELOW it so
  // the diffs hook + selection hook can read the controller context.
  return (
    <ThemeSourceProvider controller={themeController}>
      <ReviewUIInner
        domain={domain}
        initialUrl={initialUrl}
        path={path}
        returnToPullPath={returnToPullPath}
      />
    </ThemeSourceProvider>
  );
}

function ReviewUIInner({
  domain,
  initialUrl,
  path,
  returnToPullPath,
}: ReviewUIProps) {
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  // The user's explicit split/unified pick. The live diffStyle is viewport-
  // managed (mobile always renders unified), so only this preference — not
  // the effective style — persists and is restored on desktop.
  const [diffStylePreference, setDiffStylePreference] = useState<
    'split' | 'unified' | null
  >(null);
  const handleSetDiffStyle = useCallback((style: 'split' | 'unified') => {
    setDiffStylePreference(style);
    setDiffStyle(style);
    updateDisplaySettings({ diffStyle: style });
  }, []);
  const [collapseMode, setCollapseMode] = useState<'expanded' | 'collapsed'>(
    DEFAULT_DISPLAY_SETTINGS.collapseMode
  );
  const [fileTreeOverlayOpen, setFileTreeOverlayOpen] = useState(false);
  const [markdownView, setMarkdownView] = useState<'rendered' | 'raw'>(
    DEFAULT_DISPLAY_SETTINGS.markdownView
  );
  // Auto-collapse patterns are a persisted personal preference; load them
  // after mount so the SSR markup stays deterministic.
  const [collapsePatternsText, setCollapsePatternsText] = useState('');
  useEffect(() => {
    setCollapsePatternsText(loadCollapsePatternsText());
  }, []);
  const collapsePatterns = useMemo(
    () => compileCollapsePatterns(parseCollapsePatterns(collapsePatternsText)),
    [collapsePatternsText]
  );
  const [overflow, setOverflow] = useState<'wrap' | 'scroll'>(
    DEFAULT_DISPLAY_SETTINGS.overflow
  );
  const [showBackgrounds, setShowBackgrounds] = useState<boolean>(
    DEFAULT_DISPLAY_SETTINGS.showBackgrounds
  );
  const [diffIndicators, setDiffIndicators] = useState<DiffIndicators>(
    DEFAULT_DISPLAY_SETTINGS.diffIndicators
  );
  const [lineNumbers, setLineNumbers] = useState<boolean>(
    DEFAULT_DISPLAY_SETTINGS.lineNumbers
  );
  // Header controls for the display settings with no other side effects:
  // each updates state and persists only the changed field.
  const handleSetDiffIndicators = useCallback((value: DiffIndicators) => {
    setDiffIndicators(value);
    updateDisplaySettings({ diffIndicators: value });
  }, []);
  const handleSetLineNumbers = useCallback((value: boolean) => {
    setLineNumbers(value);
    updateDisplaySettings({ lineNumbers: value });
  }, []);
  const handleSetOverflow = useCallback((value: 'wrap' | 'scroll') => {
    setOverflow(value);
    updateDisplaySettings({ overflow: value });
  }, []);
  const handleSetShowBackgrounds = useCallback((value: boolean) => {
    setShowBackgrounds(value);
    updateDisplaySettings({ showBackgrounds: value });
  }, []);
  const {
    clearToken: clearGitHubToken,
    hasToken: hasGitHubToken,
    hydrated: githubTokenHydrated,
    setToken: setGitHubToken,
    token: githubToken,
    tokenVersion: githubTokenVersion,
  } = useGitHubToken();
  const { getGitHubToken, loadDiffFiles } = useGitHubDiffFileLoader({
    domain,
    hasGitHubToken,
    path,
    token: githubToken,
    tokenVersion: githubTokenVersion,
  });
  // All theming state — color mode and the light/dark theme-name picks — lives
  // in the single @pierre/theming controller (the same instance the app-wide
  // ThemeProvider is bound to). Reading it here means picking Auto/Light/Dark
  // flips both the CodeView's `themeType` and the app's <html> class, and the
  // theme-name picks persist with no separate local state.
  const themeState = useThemeController(themeController);

  // The controller reads persisted values synchronously when its module loads
  // on the client, so useSyncExternalStore would surface them on the very first
  // client render — but the server rendered the defaults. Gate every
  // theme-derived value (rendered into inline chrome styles + the CodeView
  // themeType) behind a hydration snapshot so the first client render matches
  // the SSR markup, then flips to the user's selection. This also keeps the
  // CodeView from mounting against the default palette before the persisted
  // values apply.
  const themesHydrated = useIsHydrated();

  const colorMode: ColorMode = themesHydrated ? themeState.mode : 'system';
  const appResolvedTheme = themesHydrated
    ? themeState.resolvedColorScheme
    : undefined;
  const lightThemeName = themesHydrated
    ? themeState.lightThemeName
    : docsThemeCatalog.defaultLightThemeName;
  const darkThemeName = themesHydrated
    ? themeState.darkThemeName
    : docsThemeCatalog.defaultDarkThemeName;
  const setColorMode = useCallback((mode: ColorMode) => {
    themeController.setColorMode(mode);
  }, []);
  const setLightThemeName = useCallback((name: LightThemeName) => {
    themeController.setThemeNameForScheme('light', name);
  }, []);
  const setDarkThemeName = useCallback((name: DarkThemeName) => {
    themeController.setThemeNameForScheme('dark', name);
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CodeViewHandle<CommentMetadata, undefined> | null>(
    null
  );
  const stressTest = useStressTest({
    viewerRef,
    lightThemeName,
    darkThemeName,
    resolvedThemeMode: appResolvedTheme,
    setLightThemeName,
    setDarkThemeName,
    setColorMode,
  });

  // GitHub-instance sources (pull, commit, compare) drive review threads,
  // pinning, and the edit flows; arbitrary-domain patch URLs get none of
  // these.
  const githubSource = useMemo(
    () =>
      domain != null && domain !== '' ? undefined : parseGitHubDiffSource(path),
    [domain, path]
  );
  // Review threads and comment publishing only exist for pull requests.
  const pullRequest = useMemo<PullRequestRef | undefined>(
    () =>
      githubSource?.kind === 'pull'
        ? {
            number: githubSource.number,
            owner: githubSource.repo.owner,
            repo: githubSource.repo.repo,
          }
        : undefined,
    [githubSource]
  );
  // Any GitHub-instance view can be pinned to the /pulls dashboard.
  const pinnableRepo =
    githubSource == null
      ? undefined
      : `${githubSource.repo.owner}/${githubSource.repo.repo}`;
  // The diff→tree side of the browse/diff toggle: the repo file browser at
  // this diff's head ref, when the head has a client-resolvable name.
  const browseFilesPath =
    githubSource == null
      ? undefined
      : (buildDiffHeadTreePath(githubSource) ?? undefined);
  // Record the visit for the recents list (dashboard + command palette). The
  // patch stream has no PR title, so this records path-only; entries clicked
  // from surfaces that know the title merge it in without clobbering.
  useEffect(() => {
    if (domain == null || domain === '') {
      recordRecentDiff({ path });
    }
  }, [domain, path]);
  const handlePatchLoadStart = useCallback(() => {
    setFileTreeOverlayOpen(false);
  }, []);
  // On mobile the sidebar is an overlay, so opening its search tab also has
  // to show the overlay; on desktop the flag is ignored.
  const openSearchTabOverlay = useCallback(() => {
    if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) {
      setFileTreeOverlayOpen(true);
    }
  }, []);
  const {
    applyCollapseModeToLoaded,
    applyCollapsePatternsToLoaded,
    applyHiddenItemsToLoaded,
    applyMarkdownViewToLoaded,
    commentFileByItemId,
    commentSections,
    diffStats,
    errorMessage,
    getLoadedItemIds,
    initialItems,
    isFileReviewed,
    loadState,
    onLineLinkChange,
    onViewerReady,
    recordViewTarget,
    retryLoad,
    scrollToItem,
    setCommentSections,
    setFileReviewed,
    treeSource,
    viewerKey,
  } = usePatchLoader({
    collapseMode,
    collapsePatterns,
    domain,
    getGitHubToken,
    githubTokenVersion,
    markdownView,
    onLoadStart: handlePatchLoadStart,
    path,
    tokenHydrated: githubTokenHydrated,
    viewerRef,
  });
  const diffSearch = useDiffSearchController({
    getLoadedItemIds,
    itemsVersion: treeSource,
    loadDiffFiles,
    viewerRef,
  });
  const {
    findBarProps,
    handleSymbolHover,
    handleSymbolNavigate,
    renderSearchPanel,
    searchTabRequest,
    symbolPreview,
  } = useDiffSearchUI({
    controller: diffSearch,
    onOpenSearchTab: openSearchTabOverlay,
  });

  // What the diff compares, for the header's base/head display. Compare
  // ranges carry both refs in the URL; pulls need their metadata fetched.
  const { pullInfo, mergePullDetails, viewerHeadSha } = usePullInfo({
    getGitHubToken,
    githubTokenVersion,
    pullRequest,
    tokenHydrated: githubTokenHydrated,
    viewerKey,
  });
  // The head commit of the diff on screen, from pull info fetched for this
  // same diff load (undefined until that fetch lands). New review comments
  // anchor to it rather than to whatever the head is when they are
  // submitted; without it the route falls back to the current head.
  const pullHeadSha = viewerHeadSha;
  const diffRefs = useMemo(
    () =>
      githubSource == null ? null : describeDiffRefs(githubSource, pullInfo),
    [githubSource, pullInfo]
  );
  // The Conversation's description, reflecting edits from the header panel.
  const pullAuthorLogin = pullInfo?.details?.authorLogin;
  const pullBody = pullInfo?.details?.body;
  const pullDescription = useMemo(
    () =>
      pullBody == null
        ? null
        : { authorLogin: pullAuthorLogin, body: pullBody },
    [pullAuthorLogin, pullBody]
  );

  const editSession = usePullEditSession({
    getGitHubToken,
    githubTokenVersion,
    hasDiffFileLoader: loadDiffFiles != null,
    hasGitHubToken,
    pullRequest,
    retryLoad,
    viewerKey,
    viewerRef,
  });
  // Conflict detection is lazy: GitHub's `mergeable` flag from pull-info
  // decides whether the Conflicts button shows (when pull-info caught GitHub
  // mid-computation, usePullInfo re-asks with `waitMergeable=1` and folds the
  // answer in), and the merge itself, which fetches every both-changed file,
  // only runs once the viewer opens the resolver.
  const pullMergeable = pullInfo?.details?.mergeable;
  const pullIsOpen = pullInfo?.details?.state === 'open';
  const [conflicts, setConflicts] = useState<PullConflictsResult | null>(null);
  const [conflictResolverOpen, setConflictResolverOpen] = useState(false);
  useEffect(() => {
    setConflicts(null);
    setConflictResolverOpen(false);
  }, [githubTokenVersion, loadState, pullMergeable, pullRequest]);
  // Opening the resolver computes the merge on first open. A failure, or a
  // pull that no longer conflicts, closes it again with a toast; closing it
  // mid-request aborts the request.
  const conflictsLoading = conflictResolverOpen && conflicts == null;
  useEffect(() => {
    if (!conflictsLoading || pullRequest == null) {
      return;
    }
    const controller = new AbortController();
    fetchPullConflicts(pullRequest, getGitHubToken(), controller.signal)
      .then((result) => {
        setConflicts(result);
        if (!result.conflicted) {
          setConflictResolverOpen(false);
          toast.success('This pull request no longer has merge conflicts.');
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setConflictResolverOpen(false);
        toast.error(
          error instanceof Error
            ? error.message
            : 'Checking for merge conflicts failed.',
          { id: 'pull-conflicts-error' }
        );
      });
    return () => controller.abort();
  }, [conflictsLoading, getGitHubToken, pullRequest]);
  const showConflicts =
    hasGitHubToken &&
    pullIsOpen &&
    pullMergeable === false &&
    conflicts?.conflicted !== false;
  const conflictedFileCount =
    conflicts?.conflicted === true
      ? conflicts.files.length + conflicts.unsupported.length
      : undefined;
  // Close and reload — used both when the merge commit lands and when a
  // branch tip moved mid-resolution: either way the loaded diff is stale, and
  // the next open recomputes the merge against fresh tips.
  const handleConflictsSettled = useCallback(() => {
    setConflictResolverOpen(false);
    setConflicts(null);
    retryLoad();
  }, [retryLoad]);

  // Restore persisted display settings after mount (the server render uses
  // the defaults, so hydrating in an effect keeps SSR markup deterministic —
  // same pattern as the theme controller). The apply* calls also rewrite any
  // items that may have loaded before this effect ran. Settings are saved only
  // by the user-action handlers, so restoring never writes defaults back.
  // The collapse mode and markdown view currently applied to loaded files.
  // A restore re-walks the files only when one of these actually changes,
  // since re-applying would also expand files collapsed by a reviewed mark or
  // a pattern and reset per-file markdown toggles.
  const collapseModeRef = useRef(collapseMode);
  const markdownViewRef = useRef(markdownView);
  useEffect(() => {
    collapseModeRef.current = collapseMode;
    markdownViewRef.current = markdownView;
  }, [collapseMode, markdownView]);
  // Applies the stored settings, with the defaults for any field the stored
  // object lacks (a restored server copy can carry fewer fields than this
  // browser had set).
  const restoreDisplaySettings = useCallback(() => {
    const stored = { ...DEFAULT_DISPLAY_SETTINGS, ...loadDisplaySettings() };
    const diffStylePick = stored.diffStyle ?? null;
    setDiffStylePreference(diffStylePick);
    if (!window.matchMedia(MOBILE_MEDIA_QUERY).matches) {
      setDiffStyle(diffStylePick ?? 'split');
    }
    setCollapseMode(stored.collapseMode);
    if (stored.collapseMode !== collapseModeRef.current) {
      collapseModeRef.current = stored.collapseMode;
      applyCollapseModeToLoaded(stored.collapseMode);
    }
    setMarkdownView(stored.markdownView);
    if (stored.markdownView !== markdownViewRef.current) {
      markdownViewRef.current = stored.markdownView;
      applyMarkdownViewToLoaded(stored.markdownView);
    }
    setDiffIndicators(stored.diffIndicators);
    setLineNumbers(stored.lineNumbers);
    setOverflow(stored.overflow);
    setShowBackgrounds(stored.showBackgrounds);
  }, [applyCollapseModeToLoaded, applyMarkdownViewToLoaded]);
  useEffect(() => {
    restoreDisplaySettings();
  }, [restoreDisplaySettings]);
  const applyCollapsePatternsText = useCallback(
    (text: string) => {
      applyCollapsePatternsToLoaded(
        compileCollapsePatterns(parseCollapsePatterns(text))
      );
    },
    [applyCollapsePatternsToLoaded]
  );
  // Display settings and auto-collapse patterns restored from the server after
  // sign-in (lib/preferenceSync) land in localStorage after the mount-time
  // reads above, so re-read and re-apply them.
  useEffect(
    () => onPreferencesRestored(['displaySettings'], restoreDisplaySettings),
    [restoreDisplaySettings]
  );
  useEffect(
    () =>
      onPreferencesRestored(['collapsePatterns'], () => {
        const text = loadCollapsePatternsText();
        setCollapsePatternsText(text);
        applyCollapsePatternsText(text);
      }),
    [applyCollapsePatternsText]
  );
  // Re-runs when the preference changes; that just re-applies the style the
  // setter already set, and keeps the breakpoint restore reading one source
  // of truth.
  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const updateMobileState = (matches: boolean) => {
      setDiffStyle(matches ? 'unified' : (diffStylePreference ?? 'split'));
      if (!matches) setFileTreeOverlayOpen(false);
    };
    const handleChange = (event: MediaQueryListEvent) => {
      updateMobileState(event.matches);
    };

    updateMobileState(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [diffStylePreference]);
  // A file-header click behaves like selecting the file in the tree: scroll
  // the file to the top and record it as the URL hash target.
  const handleFileHeaderSelect = useCallback(
    (itemId: string) => {
      recordViewTarget(itemId);
      scrollToItem(itemId);
    },
    [recordViewTarget, scrollToItem]
  );
  // A rendered-document link naming a file that is part of this diff opens
  // it in the viewer, same as selecting it in the tree; anything else keeps
  // the link's own navigation to the GitHub instance.
  const handleOpenDocFile = useCallback(
    (path: string): boolean => {
      const itemId = treeSource?.pathToItemId.get(path);
      if (itemId == null) {
        return false;
      }
      handleFileHeaderSelect(itemId);
      return true;
    },
    [handleFileHeaderSelect, treeSource]
  );
  const handleSelectTreeItem = useCallback(
    (itemId: string) => {
      setFileTreeOverlayOpen(false);
      const viewer = viewerRef.current;
      if (viewer == null) {
        return;
      }
      const item = viewer.getItem(itemId);
      if (item != null && item.collapsed === true) {
        item.collapsed = false;
        incrementItemVersion(item);
        viewer.updateItem(item);
      }
      handleFileHeaderSelect(itemId);
    },
    [handleFileHeaderSelect]
  );
  // The go-to-file palette's view of the diff: the streamed path list is a
  // growing accumulator the source aliases, so copy only the settled prefix.
  const fileSearchPaths = useMemo(
    () =>
      treeSource == null
        ? null
        : treeSource.paths.slice(0, treeSource.pathCount),
    [treeSource]
  );
  const handleFileSearchSelect = useCallback(
    (path: string) => {
      const itemId = treeSource?.pathToItemId.get(path);
      if (itemId != null) {
        handleSelectTreeItem(itemId);
      }
    },
    [handleSelectTreeItem, treeSource]
  );
  const handleToggleCollapseMode = useCallback(() => {
    const next = collapseMode === 'expanded' ? 'collapsed' : 'expanded';
    setCollapseMode(next);
    applyCollapseModeToLoaded(next);
    updateDisplaySettings({ collapseMode: next });
  }, [applyCollapseModeToLoaded, collapseMode]);
  const handleToggleMarkdownView = useCallback(() => {
    const next = markdownView === 'rendered' ? 'raw' : 'rendered';
    setMarkdownView(next);
    applyMarkdownViewToLoaded(next);
    updateDisplaySettings({ markdownView: next });
  }, [applyMarkdownViewToLoaded, markdownView]);
  // The textarea updates per keystroke, but persisting and re-walking every
  // loaded item is debounced — intermediate prefixes like "ven" are valid
  // patterns and would collapse files mid-typing (collapse is one-directional,
  // so a premature match can't be undone by finishing the word).
  const collapsePatternsApplyTimeoutRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (collapsePatternsApplyTimeoutRef.current != null) {
        window.clearTimeout(collapsePatternsApplyTimeoutRef.current);
      }
    },
    []
  );
  const handleCollapsePatternsChange = useCallback(
    (text: string) => {
      setCollapsePatternsText(text);
      if (collapsePatternsApplyTimeoutRef.current != null) {
        window.clearTimeout(collapsePatternsApplyTimeoutRef.current);
      }
      collapsePatternsApplyTimeoutRef.current = window.setTimeout(() => {
        collapsePatternsApplyTimeoutRef.current = null;
        saveCollapsePatternsText(text);
        applyCollapsePatternsText(text);
      }, 500);
    },
    [applyCollapsePatternsText]
  );
  const handleCommentSaved = useCallback(
    (comment: DiffsHubSavedCommentEvent) => {
      setCommentSections((prev) =>
        upsertSavedCommentSidebarEntry(prev, commentFileByItemId, comment)
      );
    },
    [commentFileByItemId, setCommentSections]
  );
  // Re-runs thread application when the CodeView handle (re)mounts, which can
  // happen after the patch is already loaded (worker pool warm-up).
  const [viewerReadyTick, setViewerReadyTick] = useState(0);
  const { attachViewer } = diffSearch;
  const handleViewerReady = useCallback(() => {
    onViewerReady();
    attachViewer();
    setViewerReadyTick((tick) => tick + 1);
  }, [attachViewer, onViewerReady]);
  const [discussion, setDiscussion] = useState<PullDiscussionComment[]>([]);
  // Bumped after a review submission so the thread hook refetches and injects
  // the newly created GitHub threads (and the review summary in discussion).
  const [threadsRefreshTick, setThreadsRefreshTick] = useState(0);
  usePullReviewThreads({
    loadState,
    onDiscussionLoaded: setDiscussion,
    onThreadApplied: handleCommentSaved,
    pathToItemId: treeSource?.pathToItemId ?? null,
    pullRequest,
    refreshTick: threadsRefreshTick,
    token: githubToken,
    tokenHydrated: githubTokenHydrated,
    viewerKey,
    viewerReadyTick,
    viewerRef,
  });
  // PR-level conversation writes (issue comments on the pull request). Each
  // handler posts through the API proxy, surfaces failures as a toast, and
  // rethrows so the composer keeps the draft; on success the discussion state
  // updates in place. New comments append — the list is sorted by creation
  // time, and a fresh comment is always newest.
  const requireDiscussionContext = useCallback(() => {
    const token = getGitHubToken();
    if (pullRequest == null || token === '') {
      throw new Error('Commenting requires signing in or saving a token.');
    }
    return { pullRequest, token };
  }, [getGitHubToken, pullRequest]);
  const handleDiscussionPost = useCallback(
    async (body: string) => {
      const context = requireDiscussionContext();
      const comment = await postPullDiscussionComment(
        context.pullRequest,
        context.token,
        body
      ).catch((error: unknown) =>
        toastRequestError(error, 'Posting the comment failed.')
      );
      setDiscussion((prev) => [...prev, comment]);
    },
    [requireDiscussionContext]
  );
  const handleDiscussionEdit = useCallback(
    async (commentId: number, body: string) => {
      const context = requireDiscussionContext();
      const edited = await editPullDiscussionComment(
        context.pullRequest,
        context.token,
        commentId,
        body
      ).catch((error: unknown) =>
        toastRequestError(error, 'Editing the comment failed.')
      );
      setDiscussion((prev) =>
        prev.map((comment) =>
          comment.kind === 'comment' && comment.id === commentId
            ? { ...comment, body: edited.body }
            : comment
        )
      );
    },
    [requireDiscussionContext]
  );
  const handleDiscussionDelete = useCallback(
    async (commentId: number) => {
      const context = requireDiscussionContext();
      await deletePullDiscussionComment(
        context.pullRequest,
        context.token,
        commentId
      ).catch((error: unknown) =>
        toastRequestError(error, 'Deleting the comment failed.')
      );
      setDiscussion((prev) =>
        prev.filter(
          (comment) => comment.kind !== 'comment' || comment.id !== commentId
        )
      );
    },
    [requireDiscussionContext]
  );
  const discussionActions = useMemo<DiscussionActions | undefined>(
    () =>
      pullRequest == null
        ? undefined
        : {
            canWrite: hasGitHubToken,
            onDelete: handleDiscussionDelete,
            onEdit: handleDiscussionEdit,
            onPost: handleDiscussionPost,
          },
    [
      handleDiscussionDelete,
      handleDiscussionEdit,
      handleDiscussionPost,
      hasGitHubToken,
      pullRequest,
    ]
  );
  const handleCommentDeleted = useCallback(
    (comment: DiffsHubDeletedCommentEvent) => {
      setCommentSections((prev) =>
        removeSavedCommentSidebarEntry(prev, comment)
      );
    },
    [setCommentSections]
  );
  // The in-progress batched review: the viewer keeps the map in sync as
  // pending cards are added/edited/deleted, the header control submits the
  // whole batch with a verdict, and the hook persists it per pull request so
  // a reload restores the cards instead of discarding them.
  const {
    clearPendingReviewComments,
    handlePendingReviewCommentRemoved,
    handlePendingReviewCommentUpserted,
    pendingReviewComments,
  } = usePendingReviewComments({
    loadState,
    onRestored: handleCommentSaved,
    pathToItemId: treeSource?.pathToItemId ?? null,
    pullHeadSha,
    pullRequest,
    viewerKey,
    viewerReadyTick,
    viewerRef,
  });
  // Warn before navigating away while edits are uncommitted. The pending
  // review batch survives a reload via its per-PR persistence, but edit
  // sessions do not — and either way an accidental close mid-review deserves
  // a prompt.
  useEffect(() => {
    if (
      editSession.dirtyFiles.length === 0 &&
      pendingReviewComments.size === 0
    ) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [editSession.dirtyFiles.length, pendingReviewComments.size]);
  const handleSubmitReview = useCallback(
    async (event: PullReviewEvent, body: string) => {
      const token = getGitHubToken();
      if (pullRequest == null || token === '') {
        throw new Error(
          'Submitting a review requires signing in or saving a token.'
        );
      }
      const entries = [...pendingReviewComments.values()];
      const commitChoice = chooseReviewCommit(entries, pullHeadSha);
      if (commitChoice.staleEntries.length > 0) {
        toastRequestError(
          new Error(describeStaleReviewEntries(commitChoice.staleEntries)),
          'Submitting the review failed.'
        );
      }
      const comments: PullReviewDraftComment[] = [];
      for (const entry of entries) {
        const anchor = createCommentAnchor(entry.path, entry.range);
        if (anchor != null) {
          comments.push({ ...anchor, body: entry.message });
        }
      }
      await submitPullReview(
        pullRequest,
        token,
        event,
        body,
        comments,
        commitChoice.commitId
      ).catch((error: unknown) =>
        toastRequestError(error, 'Submitting the review failed.')
      );
      // Drop the local pending cards and their sidebar entries; the refetch
      // below re-injects the submitted comments as real GitHub threads and
      // adds the review summary to the discussion feed. Entries carry only
      // their file path, so each resolves its item id here; removals are
      // grouped per file so each item re-renders once, not once per comment.
      const viewer = viewerRef.current;
      const pathToItemId = treeSource?.pathToItemId;
      const keysByItemId = new Map<string, Set<string>>();
      for (const entry of entries) {
        const itemId = pathToItemId?.get(entry.path);
        if (itemId == null) {
          continue;
        }
        let keys = keysByItemId.get(itemId);
        if (keys == null) {
          keys = new Set();
          keysByItemId.set(itemId, keys);
        }
        keys.add(entry.key);
        handleCommentDeleted({ itemId, key: entry.key });
      }
      for (const [itemId, keys] of keysByItemId) {
        const item = viewer?.getItem(itemId);
        if (
          viewer == null ||
          item == null ||
          !isDiffItem(item) ||
          item.annotations == null
        ) {
          continue;
        }
        const nextAnnotations = item.annotations.filter(
          (annotation) => !keys.has(annotation.metadata.key)
        );
        if (nextAnnotations.length !== item.annotations.length) {
          item.annotations = nextAnnotations;
          incrementItemVersion(item);
          viewer.updateItem(item);
        }
      }
      clearPendingReviewComments();
      setThreadsRefreshTick((tick) => tick + 1);
      toast.success('Review submitted.');
    },
    [
      clearPendingReviewComments,
      getGitHubToken,
      handleCommentDeleted,
      pendingReviewComments,
      pullHeadSha,
      pullRequest,
      treeSource,
    ]
  );
  const handleToggleFileTreeOverlay = useCallback(() => {
    setFileTreeOverlayOpen((open) => !open);
  }, []);
  const handleCloseFileTreeOverlay = useCallback(() => {
    setFileTreeOverlayOpen(false);
  }, []);
  const handleSelectComment = useCallback(
    (comment: DiffsHubSavedCommentEntry) => {
      setFileTreeOverlayOpen(false);
      const viewer = viewerRef.current;
      if (viewer == null) {
        return;
      }
      viewer.setSelectedLines({
        id: comment.itemId,
        range: comment.range,
      });
      recordViewTarget(comment.itemId, comment.range);
      // When the item's rendered-document view is open, the diff lines the
      // comment anchors to are hidden, so a line-target scroll would land in
      // collapsed space. Center the comment's card in the document's comment
      // rail instead, bringing the item into view first if it is not mounted.
      if (getOpenDocDiff(viewer.getItem(comment.itemId)) != null) {
        scrollDocTargetIntoView(
          viewer,
          comment.itemId,
          docCommentTarget(comment.key)
        );
        return;
      }
      viewer.scrollTo({
        type: 'line',
        id: comment.itemId,
        lineNumber: comment.range.end,
        side: comment.range.endSide ?? comment.range.side,
        align: 'center',
        behavior: 'smooth-auto',
      });
    },
    [recordViewTarget]
  );
  // Withhold the viewer until the persisted themes have been read from
  // localStorage. Otherwise on client-side navigation back into a diff the
  // CodeView would mount during the brief render where lightThemeName/darkThemeName
  // are still at their `DEFAULT_*_THEME` initial values and tokenize the
  // first batch of files against the wrong palette.
  const viewerAvailable =
    themesHydrated &&
    (loadState === 'ready' ||
      (loadState === 'streaming' && initialItems.length > 0));

  return (
    <>
      <ReviewGrid>
        <DiffsHubHeader
          className="[grid-area:header]"
          collapseMode={collapseMode}
          collapsePatternsText={collapsePatternsText}
          colorMode={colorMode}
          darkThemeName={darkThemeName}
          diffIndicators={diffIndicators}
          diffRefs={diffRefs}
          diffStyle={diffStyle}
          initialUrl={
            githubSource == null
              ? initialUrl
              : formatDiffSourceShorthand(githubSource)
          }
          upstreamUrl={initialUrl}
          lightThemeName={lightThemeName}
          lineNumbers={lineNumbers}
          markdownView={markdownView}
          overflow={overflow}
          pinnableRepo={pinnableRepo}
          browseFilesPath={browseFilesPath}
          returnToPullPath={returnToPullPath}
          reviewControl={
            pullRequest != null ? (
              <>
                <PullCommitRangePicker
                  getGitHubToken={getGitHubToken}
                  githubTokenVersion={githubTokenVersion}
                  pullRequest={pullRequest}
                />
                <PullDetailsControl
                  canWrite={hasGitHubToken}
                  getGitHubToken={getGitHubToken}
                  githubTokenVersion={githubTokenVersion}
                  onDetailsEdited={mergePullDetails}
                  onMerged={retryLoad}
                  pullInfo={pullInfo}
                  pullRequest={pullRequest}
                />
                {showConflicts && (
                  <PullConflictControl
                    conflictedFileCount={conflictedFileCount}
                    loading={conflictsLoading}
                    onOpen={() => setConflictResolverOpen(true)}
                  />
                )}
                <PullCommitPanel
                  editSession={editSession}
                  pendingReviewCount={pendingReviewComments.size}
                  onSelectFile={recordViewTarget}
                />
                <ReviewSubmitControl
                  authorLogin={pullAuthorLogin}
                  canWrite={hasGitHubToken}
                  pendingCount={pendingReviewComments.size}
                  onSubmit={handleSubmitReview}
                />
              </>
            ) : undefined
          }
          fileTreeOverlayOpen={fileTreeOverlayOpen}
          fileTreeAvailable={treeSource != null}
          fileSearchAvailable={fileSearchPaths != null}
          githubTokenActive={hasGitHubToken}
          onClearGitHubToken={clearGitHubToken}
          onCollapsePatternsChange={handleCollapsePatternsChange}
          onSaveGitHubToken={setGitHubToken}
          onToggleCollapseMode={handleToggleCollapseMode}
          onToggleFileTreeOverlay={handleToggleFileTreeOverlay}
          onToggleMarkdownView={handleToggleMarkdownView}
          setColorMode={setColorMode}
          setDarkThemeName={setDarkThemeName}
          setDiffIndicators={handleSetDiffIndicators}
          setDiffStyle={handleSetDiffStyle}
          setLightThemeName={setLightThemeName}
          setLineNumbers={handleSetLineNumbers}
          setOverflow={handleSetOverflow}
          setShowBackgrounds={handleSetShowBackgrounds}
          showBackgrounds={showBackgrounds}
        />
        {viewerAvailable && treeSource != null ? (
          <>
            <DiffsHubSidebar
              className="[grid-area:viewer] md:[grid-area:tree]"
              commentSections={commentSections}
              description={pullDescription}
              diffStats={diffStats}
              discussion={discussion}
              discussionActions={discussionActions}
              mobileOverlayOpen={fileTreeOverlayOpen}
              onHiddenItemsChange={applyHiddenItemsToLoaded}
              onMobileClose={handleCloseFileTreeOverlay}
              onSelectComment={handleSelectComment}
              renderSearchPanel={renderSearchPanel}
              searchTabRequest={searchTabRequest}
              scrollRef={scrollRef}
              source={treeSource}
              streaming={loadState === 'streaming'}
              stressTest={stressTest}
              onSelectItem={handleSelectTreeItem}
            />
            <DiffsHubViewer
              key={viewerKey}
              className="[grid-area:viewer]"
              diffStyle={diffStyle}
              overflow={overflow}
              showBackgrounds={showBackgrounds}
              diffIndicators={diffIndicators}
              lineNumbers={lineNumbers}
              scrollRef={scrollRef}
              themeType={colorMode}
              viewerRef={viewerRef}
              initialItems={initialItems}
              loadDiffFiles={loadDiffFiles}
              pullRequest={pullRequest}
              pullHeadSha={pullHeadSha}
              sourcePath={domain == null ? path : undefined}
              editSession={editSession}
              getGitHubToken={getGitHubToken}
              isFileReviewed={isFileReviewed}
              pendingReviewCount={pendingReviewComments.size}
              onCommentDeleted={handleCommentDeleted}
              onCommentSaved={handleCommentSaved}
              onFileHeaderSelect={handleFileHeaderSelect}
              onOpenDocFile={handleOpenDocFile}
              onLineLinkChange={onLineLinkChange}
              onPendingReviewCommentRemoved={handlePendingReviewCommentRemoved}
              onPendingReviewCommentUpserted={
                handlePendingReviewCommentUpserted
              }
              onSetFileReviewed={setFileReviewed}
              onRowsRendered={diffSearch.refreshHighlights}
              onSymbolHover={handleSymbolHover}
              onSymbolNavigate={handleSymbolNavigate}
              onViewerReady={handleViewerReady}
            />
            {findBarProps != null && (
              <DiffFindBar
                {...findBarProps}
                className="z-20 mt-12 mr-4 self-start justify-self-end [grid-area:viewer]"
              />
            )}
            {symbolPreview}
          </>
        ) : (
          <DiffsHubStatusPanel
            errorMessage={errorMessage}
            onRetry={retryLoad}
            state={loadState}
          />
        )}
      </ReviewGrid>
      {fileSearchPaths != null && (
        <FileSearchPalette
          paths={fileSearchPaths}
          onSelectPath={handleFileSearchSelect}
        />
      )}
      {conflictResolverOpen &&
        conflicts?.conflicted === true &&
        pullRequest != null && (
          <PullConflictResolver
            conflicts={conflicts}
            pull={pullRequest}
            getGitHubToken={getGitHubToken}
            onClose={() => setConflictResolverOpen(false)}
            onMerged={handleConflictsSettled}
            onStale={handleConflictsSettled}
          />
        )}
    </>
  );
}

interface ReviewGridProps {
  children: ReactNode;
}

function ReviewGrid({ children }: ReviewGridProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden overscroll-contain contain-strict [grid-template-areas:'header''viewer'] md:grid-cols-[320px_minmax(0,1fr)] md:[grid-template-areas:'header_header''tree_viewer']">
      {children}
    </div>
  );
}
