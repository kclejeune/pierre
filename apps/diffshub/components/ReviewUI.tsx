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

import type { DiscussionActions } from './DiffsHubCommentsList';
import { DiffsHubHeader } from './DiffsHubHeader';
import { DiffsHubSidebar } from './DiffsHubSidebar';
import { DiffsHubStatusPanel } from './DiffsHubStatusPanel';
import { DiffsHubViewer } from './DiffsHubViewer';
import { PullCommitPanel } from './PullCommitPanel';
import {
  PullConflictControl,
  PullConflictResolver,
} from './PullConflictResolver';
import { ReviewSubmitControl } from './ReviewSubmitControl';
import { ThemeSourceProvider } from './ThemeSourceProvider';
import { useGitHubToken } from './useGitHubToken';
import { useIsWorkerPoolReadyOrDisabled } from './useIsWorkerPoolReadyOrDisabled';
import { usePatchLoader } from './usePatchLoader';
import { usePendingReviewComments } from './usePendingReviewComments';
import { usePullEditSession } from './usePullEditSession';
import { usePullInfo } from './usePullInfo';
import { usePullReviewThreads } from './usePullReviewThreads';
import { useThemeCycle } from './useThemeCycle';
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
import { describeDiffRefs, formatDiffSourceShorthand } from '@/lib/diffRefs';
import {
  loadDisplaySettings,
  saveDisplaySettings,
} from '@/lib/displaySettings';
import { createGitHubDiffFileLoader } from '@/lib/githubDiffFileLoader';
import { parseGitHubDiffSource } from '@/lib/githubDiffSource';
import { incrementItemVersion } from '@/lib/incrementItemVersion';
import { isDiffItem } from '@/lib/isDiffItem';
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
import { buildDiffHeadTreePath } from '@/lib/repoBrowser';
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
}

export function ReviewUI({ domain, initialUrl, path }: ReviewUIProps) {
  // Provide the diffshub-scoped theme context, then render the body BELOW it so
  // the diffs hook + selection hook can read the controller context.
  return (
    <ThemeSourceProvider controller={themeController}>
      <ReviewUIInner domain={domain} initialUrl={initialUrl} path={path} />
    </ThemeSourceProvider>
  );
}

function ReviewUIInner({ domain, initialUrl, path }: ReviewUIProps) {
  const isWorkerPoolReadyOrDisable = useIsWorkerPoolReadyOrDisabled();
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
  }, []);
  const [collapseMode, setCollapseMode] = useState<'expanded' | 'collapsed'>(
    'expanded'
  );
  const [fileTreeOverlayOpen, setFileTreeOverlayOpen] = useState(false);
  const [markdownView, setMarkdownView] = useState<'rendered' | 'raw'>('raw');
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
  const [overflow, setOverflow] = useState<'wrap' | 'scroll'>('scroll');
  const [showBackgrounds, setShowBackgrounds] = useState(true);
  const [diffIndicators, setDiffIndicators] = useState<DiffIndicators>('bars');
  const [lineNumbers, setLineNumbers] = useState(true);
  const {
    clearToken: clearGitHubToken,
    hasToken: hasGitHubToken,
    hydrated: githubTokenHydrated,
    setToken: setGitHubToken,
    token: githubToken,
    tokenVersion: githubTokenVersion,
  } = useGitHubToken();
  const githubTokenRef = useRef(githubToken);
  const githubTokenVersionRef = useRef(githubTokenVersion);
  useEffect(() => {
    githubTokenRef.current = githubToken;
  }, [githubToken]);
  useEffect(() => {
    githubTokenVersionRef.current = githubTokenVersion;
  }, [githubTokenVersion]);
  const getGitHubToken = useCallback(() => githubTokenRef.current, []);
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
  // themeType) behind a client-mounted flag so the first client render matches
  // the SSR markup, then flips to the user's selection. This also keeps the
  // long-lived WorkerPool and the CodeView from mounting against the default
  // palette before the persisted values apply.
  const [themesHydrated, setThemesHydrated] = useState(false);
  useEffect(() => {
    setThemesHydrated(true);
  }, []);

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
  // The cycle button in the System Monitor sweeps through every Shiki
  // theme so reviewers can preview the full set without manually picking
  // each one. The hook captures the user's current pick when cycling
  // starts so the visible theme anchors the rotation.
  const themeCycle = useThemeCycle({
    lightThemeName,
    darkThemeName,
    resolvedThemeMode: appResolvedTheme,
    setLightThemeName,
    setDarkThemeName,
    setColorMode,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null);
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
  const loadDiffFiles = useMemo(
    () =>
      domain == null && hasGitHubToken
        ? createGitHubDiffFileLoader(path, {
            getAuthVersion: () => githubTokenVersionRef.current,
            getToken: () => githubTokenRef.current,
          })
        : undefined,
    [domain, hasGitHubToken, path]
  );
  const handlePatchLoadStart = useCallback(() => {
    setFileTreeOverlayOpen(false);
  }, []);
  const {
    applyCollapseModeToLoaded,
    applyCollapsePatternsToLoaded,
    applyMarkdownViewToLoaded,
    commentFileByItemId,
    commentSections,
    diffStats,
    errorMessage,
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

  // What the diff compares, for the header's base/head display. Compare
  // ranges carry both refs in the URL; pulls need their metadata fetched.
  const pullInfo = usePullInfo({
    getGitHubToken,
    githubTokenVersion,
    pullRequest,
    tokenHydrated: githubTokenHydrated,
    viewerKey,
  });
  const diffRefs = useMemo(
    () =>
      githubSource == null ? null : describeDiffRefs(githubSource, pullInfo),
    [githubSource, pullInfo]
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
  // Conflict detection: once the pull's diff has loaded, ask the server
  // whether the branch conflicts with its base. Best-effort — a failed check
  // just hides the resolve affordance.
  const [conflicts, setConflicts] = useState<PullConflictsResult | null>(null);
  const [conflictResolverOpen, setConflictResolverOpen] = useState(false);
  useEffect(() => {
    setConflicts(null);
    setConflictResolverOpen(false);
    if (pullRequest == null || !hasGitHubToken || loadState !== 'ready') {
      return;
    }
    const controller = new AbortController();
    fetchPullConflicts(pullRequest, getGitHubToken(), controller.signal)
      .then(setConflicts)
      .catch(() => undefined);
    return () => controller.abort();
  }, [
    getGitHubToken,
    githubTokenVersion,
    hasGitHubToken,
    loadState,
    pullRequest,
  ]);
  // Close and reload — used both when the merge commit lands and when a
  // branch tip moved mid-resolution: either way the loaded diff is stale, and
  // the detection effect refires on the loadState cycle with fresh tips.
  const handleConflictsSettled = useCallback(() => {
    setConflictResolverOpen(false);
    setConflicts(null);
    retryLoad();
  }, [retryLoad]);

  // Restore persisted display settings after mount (the server render uses
  // the defaults, so hydrating in an effect keeps SSR markup deterministic —
  // same pattern as the theme controller). The apply* calls also rewrite any
  // items that may have loaded before this effect ran. Saving is gated on
  // hydration so the defaults never clobber stored values.
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  useEffect(() => {
    const stored = loadDisplaySettings();
    if (stored.diffStyle != null) {
      setDiffStylePreference(stored.diffStyle);
      if (!window.matchMedia('(max-width: 767px)').matches) {
        setDiffStyle(stored.diffStyle);
      }
    }
    if (stored.collapseMode != null) {
      setCollapseMode(stored.collapseMode);
      applyCollapseModeToLoaded(stored.collapseMode);
    }
    if (stored.markdownView != null) {
      setMarkdownView(stored.markdownView);
      applyMarkdownViewToLoaded(stored.markdownView);
    }
    if (stored.diffIndicators != null) {
      setDiffIndicators(stored.diffIndicators);
    }
    if (stored.lineNumbers != null) {
      setLineNumbers(stored.lineNumbers);
    }
    if (stored.overflow != null) {
      setOverflow(stored.overflow);
    }
    if (stored.showBackgrounds != null) {
      setShowBackgrounds(stored.showBackgrounds);
    }
    setSettingsHydrated(true);
  }, [applyCollapseModeToLoaded, applyMarkdownViewToLoaded]);
  useEffect(() => {
    if (!settingsHydrated) {
      return;
    }
    saveDisplaySettings({
      collapseMode,
      diffIndicators,
      lineNumbers,
      markdownView,
      overflow,
      showBackgrounds,
      ...(diffStylePreference != null
        ? { diffStyle: diffStylePreference }
        : {}),
    });
  }, [
    collapseMode,
    diffIndicators,
    diffStylePreference,
    lineNumbers,
    markdownView,
    overflow,
    settingsHydrated,
    showBackgrounds,
  ]);

  // Re-runs when the preference changes; that just re-applies the style the
  // setter already set, and keeps the breakpoint restore reading one source
  // of truth.
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
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
  const handleToggleCollapseMode = useCallback(() => {
    const next = collapseMode === 'expanded' ? 'collapsed' : 'expanded';
    setCollapseMode(next);
    applyCollapseModeToLoaded(next);
  }, [applyCollapseModeToLoaded, collapseMode]);
  const handleToggleMarkdownView = useCallback(() => {
    const next = markdownView === 'rendered' ? 'raw' : 'rendered';
    setMarkdownView(next);
    applyMarkdownViewToLoaded(next);
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
        applyCollapsePatternsToLoaded(
          compileCollapsePatterns(parseCollapsePatterns(text))
        );
      }, 500);
    },
    [applyCollapsePatternsToLoaded]
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
  const handleViewerReady = useCallback(() => {
    onViewerReady();
    setViewerReadyTick((tick) => tick + 1);
  }, [onViewerReady]);
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
    const token = githubTokenRef.current;
    if (pullRequest == null || token === '') {
      throw new Error('Commenting requires signing in or saving a token.');
    }
    return { pullRequest, token };
  }, [pullRequest]);
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
      const token = githubTokenRef.current;
      if (pullRequest == null || token === '') {
        throw new Error(
          'Submitting a review requires signing in or saving a token.'
        );
      }
      const entries = [...pendingReviewComments.values()];
      const comments: PullReviewDraftComment[] = [];
      for (const entry of entries) {
        const anchor = createCommentAnchor(entry.path, entry.range);
        if (anchor != null) {
          comments.push({ ...anchor, body: entry.message });
        }
      }
      await submitPullReview(pullRequest, token, event, body, comments).catch(
        (error: unknown) =>
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
      handleCommentDeleted,
      pendingReviewComments,
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
      // collapsed space. Scroll to the item instead and then center the
      // comment's card in the document's comment rail.
      const item = viewer.getItem(comment.itemId);
      const docOpen =
        item?.annotations?.some(
          (annotation) => annotation.metadata?.kind === 'doc'
        ) ?? false;
      if (docOpen) {
        viewer.scrollTo({
          type: 'item',
          id: comment.itemId,
          align: 'start',
          behavior: 'smooth-auto',
        });
        scrollDocCommentIntoView(comment.key);
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
    isWorkerPoolReadyOrDisable &&
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
          reviewControl={
            pullRequest != null ? (
              <>
                {conflicts?.conflicted === true && (
                  <PullConflictControl
                    conflictedFileCount={
                      conflicts.files.length + conflicts.unsupported.length
                    }
                    onOpen={() => setConflictResolverOpen(true)}
                  />
                )}
                <PullCommitPanel
                  editSession={editSession}
                  pendingReviewCount={pendingReviewComments.size}
                  onSelectFile={recordViewTarget}
                />
                <ReviewSubmitControl
                  canWrite={hasGitHubToken}
                  pendingCount={pendingReviewComments.size}
                  onSubmit={handleSubmitReview}
                />
              </>
            ) : undefined
          }
          fileTreeOverlayOpen={fileTreeOverlayOpen}
          fileTreeAvailable={treeSource != null}
          githubTokenActive={hasGitHubToken}
          onClearGitHubToken={clearGitHubToken}
          onCollapsePatternsChange={handleCollapsePatternsChange}
          onSaveGitHubToken={setGitHubToken}
          onToggleCollapseMode={handleToggleCollapseMode}
          onToggleFileTreeOverlay={handleToggleFileTreeOverlay}
          onToggleMarkdownView={handleToggleMarkdownView}
          setColorMode={setColorMode}
          setDarkThemeName={setDarkThemeName}
          setDiffIndicators={setDiffIndicators}
          setDiffStyle={handleSetDiffStyle}
          setLightThemeName={setLightThemeName}
          setLineNumbers={setLineNumbers}
          setOverflow={setOverflow}
          setShowBackgrounds={setShowBackgrounds}
          showBackgrounds={showBackgrounds}
        />
        {viewerAvailable && treeSource != null ? (
          <>
            <DiffsHubSidebar
              className="[grid-area:viewer] md:[grid-area:tree]"
              commentSections={commentSections}
              diffStats={diffStats}
              discussion={discussion}
              discussionActions={discussionActions}
              mobileOverlayOpen={fileTreeOverlayOpen}
              onMobileClose={handleCloseFileTreeOverlay}
              onSelectComment={handleSelectComment}
              scrollRef={scrollRef}
              source={treeSource}
              streaming={loadState === 'streaming'}
              themeCycle={themeCycle}
              viewerRef={viewerRef}
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
              onViewerReady={handleViewerReady}
            />
          </>
        ) : (
          <DiffsHubStatusPanel
            errorMessage={errorMessage}
            onRetry={retryLoad}
            state={loadState}
          />
        )}
      </ReviewGrid>
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

const DOC_COMMENT_SCROLL_CANCEL_EVENTS = [
  'wheel',
  'touchstart',
  'keydown',
] as const;

// Cancels the previous card-scroll loop whenever a new selection starts.
let cancelActiveDocCommentScroll: (() => void) | null = null;

// Centers a doc-rail comment card (stamped with data-diffshub-doc-comment by
// MarkdownDocAnnotation) in the viewport. The card only exists once the
// virtualizer has mounted the item the preceding scrollTo targets AND the
// rendered document has hydrated — a network fetch on partial diffs — so the
// loop polls against a generous deadline rather than a fixed frame count, and
// keeps re-centering until layout stops shifting (mounting neighbors
// re-measure underneath a one-shot scrollIntoView). Any manual scroll input
// cancels it so the page never fights the user.
function scrollDocCommentIntoView(key: string): void {
  cancelActiveDocCommentScroll?.();
  const selector = `[data-diffshub-doc-comment="${CSS.escape(key)}"]`;
  const deadline = Date.now() + 8000;
  let stableChecks = 0;
  let timer: number | undefined;
  const cleanup = () => {
    if (timer != null) {
      window.clearTimeout(timer);
    }
    for (const type of DOC_COMMENT_SCROLL_CANCEL_EVENTS) {
      window.removeEventListener(type, cleanup, true);
    }
    if (cancelActiveDocCommentScroll === cleanup) {
      cancelActiveDocCommentScroll = null;
    }
  };
  cancelActiveDocCommentScroll = cleanup;
  for (const type of DOC_COMMENT_SCROLL_CANCEL_EVENTS) {
    window.addEventListener(type, cleanup, { capture: true, passive: true });
  }
  const tick = () => {
    if (Date.now() > deadline) {
      cleanup();
      return;
    }
    const element = document.querySelector(selector);
    if (element != null) {
      const rect = element.getBoundingClientRect();
      const visible =
        rect.top < window.innerHeight * 0.75 &&
        rect.bottom > window.innerHeight * 0.25;
      if (visible) {
        // Stop once the card has stayed put for a few checks — layout has
        // settled and lingering longer would only risk fighting the user.
        if (++stableChecks >= 5) {
          cleanup();
          return;
        }
      } else {
        stableChecks = 0;
        element.scrollIntoView({ behavior: 'auto', block: 'center' });
      }
    }
    timer = window.setTimeout(tick, 120);
  };
  tick();
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
