'use client';

import {
  areSelectionsEqual,
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewLineSelection,
  processFile,
  type SelectedLineRange,
} from '@pierre/diffs';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { matchesCollapsePattern } from '@/lib/collapsePatterns';
import { CODE_VIEW_BATCH_COUNT, getInitialBatchSize } from '@/lib/constants';
import {
  appendFileDiffToDiffsHubData,
  buildDiffsHubData,
  createDiffsHubDataAccumulator,
  type DiffsHubItemIdRename,
  snapshotDiffsHubTreeSource,
  takePendingDiffsHubItems,
} from '@/lib/diffsHubDataAccumulator';
import { applyDocPreviewToItem } from '@/lib/docPreview';
import { NO_HIDDEN_ITEM_IDS } from '@/lib/getHiddenTreeItemIds';
import { getPatchTreePathPrefix } from '@/lib/gitPatchMetadata';
import { incrementItemVersion } from '@/lib/incrementItemVersion';
import { getOpenDocDiff } from '@/lib/isDocAnnotation';
import {
  type DiffsHubLineHashTarget,
  formatDiffsHubItemHash,
  formatDiffsHubLineHash,
  parseDiffsHubLineHash,
} from '@/lib/lineHash';
import { fetchReportingRejection } from '@/lib/rejectedCredential';
import { docLineTarget } from '@/lib/renderedDocDom';
import {
  getFileDiffFingerprint,
  loadReviewedFiles,
  saveReviewedFiles,
} from '@/lib/reviewedFiles';
import {
  cancelDocTargetScroll,
  scrollDocTargetIntoView,
} from '@/lib/scrollDocTargetIntoView';
import {
  getStreamedPatchMetadata,
  streamGitPatchFiles,
} from '@/lib/streamGitPatchFiles';
import type {
  CommentMetadata,
  DiffsHubCommentFileByItemId,
  DiffsHubDiffStats,
  DiffsHubFileTreeSource,
  DiffsHubSavedCommentItem,
  ViewerLoadState,
} from '@/lib/types';

const STREAM_PUBLISH_INTERVAL_MS = 100;
const STREAM_INITIAL_PUBLISH_INTERVAL_MS = 500;
const STREAM_WORK_BUDGET_MS = 8;
const STREAM_TREE_PUBLISH_FILE_BATCH_SIZE = 1_000;
const STREAM_TREE_PUBLISH_INTERVAL_MS = 1_000;
const LINE_HASH_SETTLE_CANCEL_EVENTS = [
  'wheel',
  'touchstart',
  'keydown',
] as const;
const GENERIC_PATCH_LOAD_ERROR_MESSAGE =
  'We couldn’t load that diff. Check the URL and try again.';

interface UsePatchLoaderOptions {
  collapseMode: 'expanded' | 'collapsed';
  // Compiled auto-collapse globs; matching files arrive collapsed.
  collapsePatterns?: readonly RegExp[];
  domain?: string;
  getGitHubToken?(): string | undefined;
  githubTokenVersion?: number | string;
  // Whether markdown files should show their rendered document by default.
  markdownView?: 'rendered' | 'raw';
  onLoadStart(): void;
  path: string;
  // False until the stored GitHub token has been read (and refreshed if it
  // had expired) after mount. The patch fetch waits for it: on a hard load the
  // first effect pass runs before the token store has been re-read on the
  // client, so fetching immediately would go out anonymously — and since the
  // token version does not change when the stored token is first read, it
  // would never be retried with credentials.
  tokenHydrated: boolean;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
}

interface UsePatchLoaderResult {
  applyCollapseModeToLoaded(mode: 'expanded' | 'collapsed'): void;
  applyCollapsePatternsToLoaded(patterns: readonly RegExp[]): void;
  applyHiddenItemsToLoaded(hiddenItemIds: ReadonlySet<string>): void;
  applyMarkdownViewToLoaded(view: 'rendered' | 'raw'): void;
  commentFileByItemId: DiffsHubCommentFileByItemId | null;
  commentSections: DiffsHubSavedCommentItem[];
  diffStats: DiffsHubDiffStats | null;
  errorMessage: string | null;
  // Ids of every item handed to the viewer so far, in diff order. The viewer
  // handle has no enumeration API, so content search walks this set.
  getLoadedItemIds(): ReadonlySet<string>;
  initialItems: CodeViewItem<CommentMetadata>[];
  isFileReviewed(item: CodeViewItem<CommentMetadata>): boolean;
  loadState: ViewerLoadState;
  onLineLinkChange(selection: CodeViewLineSelection | null): void;
  onViewerReady(): void;
  recordViewTarget(itemId: string, range?: SelectedLineRange): void;
  retryLoad(): void;
  // Scrolls a file to the top with the post-click settle loop; pair with
  // recordViewTarget so the click also lands in the URL hash.
  scrollToItem(itemId: string): void;
  setCommentSections: Dispatch<SetStateAction<DiffsHubSavedCommentItem[]>>;
  setFileReviewed(itemId: string, reviewed: boolean): void;
  treeSource: DiffsHubFileTreeSource | null;
  viewerKey: number;
}

export function usePatchLoader({
  collapseMode,
  collapsePatterns,
  domain,
  getGitHubToken,
  githubTokenVersion = 0,
  markdownView = 'raw',
  onLoadStart,
  path,
  tokenHydrated,
  viewerRef,
}: UsePatchLoaderOptions): UsePatchLoaderResult {
  const [initialItems, setInitialItems] = useState<
    CodeViewItem<CommentMetadata>[]
  >([]);
  // Tree data is intentionally stored separately from items so annotation
  // updates do not cascade into the file tree and trigger needless rebuilds.
  // It is updated by fetch/stream batches in this viewer route.
  const [treeSource, setTreeSource] = useState<DiffsHubFileTreeSource | null>(
    null
  );
  const [diffStats, setDiffStats] = useState<DiffsHubDiffStats | null>(null);
  const [commentFileByItemId, setCommentFileByItemId] =
    useState<DiffsHubCommentFileByItemId | null>(null);
  const [commentSections, setCommentSections] = useState<
    DiffsHubSavedCommentItem[]
  >([]);
  const [loadState, setLoadState] = useState<ViewerLoadState>('fetching');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [viewerKey, setViewerKey] = useState(0);
  const requestIdRef = useRef(0);
  const appliedLineHashKeyRef = useRef<string | null>(null);
  const viewerKeyRef = useRef(0);
  // Tracks the ids of every item that has been handed to the viewer so we can
  // walk the full set when the user toggles collapse mode. The viewer handle
  // does not expose an enumeration API, so we maintain our own index.
  const loadedItemIdsRef = useRef<Set<string>>(new Set());
  // Mirrors the latest collapse mode so the streaming code path (which lives
  // inside a long-lived effect/closure) can read the live value without us
  // having to re-bind it on every change.
  const collapseModeRef = useRef(collapseMode);
  collapseModeRef.current = collapseMode;
  const collapsePatternsRef = useRef(collapsePatterns);
  collapsePatternsRef.current = collapsePatterns;
  const markdownViewRef = useRef(markdownView);
  markdownViewRef.current = markdownView;
  // Reviewed-file marks for the current diff source, loaded from localStorage
  // when a load starts and kept authoritative in memory afterwards.
  const reviewedFilesRef = useRef<Map<string, string>>(new Map());
  const reviewedSourceKeyRef = useRef('');
  // Ids the sidebar currently filters out of the file tree (Git-status filter
  // and tree search). Filtered-out files are collapsed in the viewer so it
  // follows the tree. `filterCollapsedIdsRef` holds only the files the filter
  // itself collapsed, so clearing the filter re-expands those without
  // touching files collapsed by hand, by pattern, or by a reviewed mark.
  const hiddenItemIdsRef = useRef<ReadonlySet<string>>(NO_HIDDEN_ITEM_IDS);
  const filterCollapsedIdsRef = useRef<Set<string>>(new Set());

  // Pre-mutates fresh items so they arrive in the viewer matching the current
  // collapse mode, then records their ids for later bulk updates. Diff items
  // are normalized in both directions because the accumulator initializes
  // deleted-file diffs as collapsed by default — without an unconditional
  // overwrite, those would stay collapsed even when the user is in expanded
  // mode. On top of the mode, three per-file defaults apply: reviewed files
  // (still matching their stored fingerprint) and auto-collapse pattern
  // matches arrive collapsed, and markdown files open their rendered document
  // when the global markdown view is 'rendered'. A reviewed mark whose
  // fingerprint no longer matches is stale — the file changed since it was
  // reviewed — and is dropped here.
  const prepareItemsForViewer = (
    items: readonly CodeViewItem<CommentMetadata>[]
  ): void => {
    const targetCollapsed = collapseModeRef.current === 'collapsed';
    const patterns = collapsePatternsRef.current;
    const reviewed = reviewedFilesRef.current;
    let reviewedChanged = false;
    for (const item of items) {
      loadedItemIdsRef.current.add(item.id);
      if (item.type !== 'diff') {
        continue;
      }
      item.collapsed = targetCollapsed;
      const storedFingerprint = reviewed.get(item.fileDiff.name);
      if (storedFingerprint != null) {
        if (storedFingerprint === getFileDiffFingerprint(item.fileDiff)) {
          item.collapsed = true;
        } else {
          reviewed.delete(item.fileDiff.name);
          reviewedChanged = true;
        }
      }
      if (
        item.collapsed !== true &&
        patterns != null &&
        patterns.length > 0 &&
        matchesCollapsePattern(item.fileDiff.name, patterns)
      ) {
        item.collapsed = true;
      }
      if (item.collapsed !== true && hiddenItemIdsRef.current.has(item.id)) {
        item.collapsed = true;
        filterCollapsedIdsRef.current.add(item.id);
      }
      if (markdownViewRef.current === 'rendered') {
        applyDocPreviewToItem(item, true);
      }
    }
    if (reviewedChanged) {
      saveReviewedFiles(reviewedSourceKeyRef.current, reviewed);
    }
  };

  // Shared traversal for the global "apply X to every loaded file" toggles.
  // `mutate` changes a diff item in place and returns whether anything
  // changed. Before the viewer mounts (e.g. the worker pool is still warming
  // up while the header is already interactive), the items buffered in
  // initialItems are rewritten instead — on shallow copies, since React state
  // must not be mutated — so they arrive in the right state once it mounts;
  // items still streaming in pick up the live settings through
  // prepareItemsForViewer. After mount, changed items get a version bump so
  // the viewer re-renders them.
  const applyToLoadedItems = (
    mutate: (item: CodeViewDiffItem<CommentMetadata>) => boolean
  ) => {
    const viewer = viewerRef.current;
    if (viewer == null) {
      setInitialItems((prev) => {
        let changed = false;
        const next = prev.map((item) => {
          if (item.type !== 'diff') {
            return item;
          }
          const copy = { ...item };
          if (!mutate(copy)) {
            return item;
          }
          changed = true;
          return copy;
        });
        return changed ? next : prev;
      });
      return;
    }
    for (const itemId of loadedItemIdsRef.current) {
      const item = viewer.getItem(itemId);
      if (item == null || item.type !== 'diff' || !mutate(item)) {
        continue;
      }
      incrementItemVersion(item);
      viewer.updateItem(item);
    }
  };

  const applyCollapseModeToLoaded = useStableCallback(
    (mode: 'expanded' | 'collapsed') => {
      const targetCollapsed = mode === 'collapsed';
      applyToLoadedItems((item) => {
        if ((item.collapsed === true) === targetCollapsed) {
          return false;
        }
        item.collapsed = targetCollapsed;
        return true;
      });
    }
  );

  // Global markdown view: force every loaded markdown item's rendered-document
  // annotation on or off.
  const applyMarkdownViewToLoaded = useStableCallback(
    (view: 'rendered' | 'raw') => {
      const shown = view === 'rendered';
      applyToLoadedItems((item) => applyDocPreviewToItem(item, shown));
    }
  );

  // Collapses every loaded file matching the given patterns. Intentionally
  // one-directional: removing a pattern never force-expands files, since that
  // would also expand files the user collapsed by hand or marked reviewed.
  const applyCollapsePatternsToLoaded = useStableCallback(
    (patterns: readonly RegExp[]) => {
      if (patterns.length === 0) {
        return;
      }
      applyToLoadedItems((item) => {
        if (
          item.collapsed === true ||
          !matchesCollapsePattern(item.fileDiff.name, patterns)
        ) {
          return false;
        }
        item.collapsed = true;
        return true;
      });
    }
  );

  // Syncs viewer collapse state with the sidebar's file filter. Only files
  // whose hidden state changed since the last call are touched, so a file the
  // user expands while filtered out stays expanded across later tree
  // publishes; it collapses again only after leaving and re-entering the
  // hidden set. Once the viewer is mounted, only that symmetric difference is
  // visited instead of every loaded item.
  const applyHiddenItemsToLoaded = useStableCallback(
    (hiddenItemIds: ReadonlySet<string>) => {
      const previousHiddenItemIds = hiddenItemIdsRef.current;
      if (previousHiddenItemIds === hiddenItemIds) {
        return;
      }
      hiddenItemIdsRef.current = hiddenItemIds;
      const filterCollapsedIds = filterCollapsedIdsRef.current;
      const mutate = (item: CodeViewDiffItem<CommentMetadata>): boolean => {
        const hidden = hiddenItemIds.has(item.id);
        if (hidden === previousHiddenItemIds.has(item.id)) {
          return false;
        }
        if (hidden) {
          if (item.collapsed === true) {
            return false;
          }
          item.collapsed = true;
          filterCollapsedIds.add(item.id);
          return true;
        }
        if (!filterCollapsedIds.delete(item.id) || item.collapsed !== true) {
          return false;
        }
        item.collapsed = false;
        return true;
      };
      const viewer = viewerRef.current;
      if (viewer == null) {
        applyToLoadedItems(mutate);
        return;
      }
      const visit = (itemId: string) => {
        const item = viewer.getItem(itemId);
        if (item == null || item.type !== 'diff' || !mutate(item)) {
          return;
        }
        incrementItemVersion(item);
        viewer.updateItem(item);
      };
      for (const itemId of hiddenItemIds) {
        if (!previousHiddenItemIds.has(itemId)) {
          visit(itemId);
        }
      }
      for (const itemId of previousHiddenItemIds) {
        if (!hiddenItemIds.has(itemId)) {
          visit(itemId);
        }
      }
    }
  );

  // A file counts as reviewed only while its stored fingerprint matches the
  // rendered diff, so marks invalidate as soon as new commits change the file.
  const isFileReviewed = useStableCallback(
    (item: CodeViewItem<CommentMetadata>): boolean => {
      if (item.type !== 'diff') {
        return false;
      }
      return (
        reviewedFilesRef.current.get(item.fileDiff.name) ===
        getFileDiffFingerprint(item.fileDiff)
      );
    }
  );

  // Marks/unmarks a file as reviewed: persists the fingerprint and collapses
  // (or re-expands) the file, GitHub-style. When collapsing a file whose top
  // is above the viewport, re-anchor the scroll so the header stays in view.
  const setFileReviewed = useStableCallback(
    (itemId: string, reviewed: boolean) => {
      const viewer = viewerRef.current;
      if (viewer == null) {
        return;
      }
      const item = viewer.getItem(itemId);
      if (item == null || item.type !== 'diff') {
        return;
      }
      const reviewedFiles = reviewedFilesRef.current;
      if (reviewed) {
        reviewedFiles.set(
          item.fileDiff.name,
          getFileDiffFingerprint(item.fileDiff)
        );
      } else {
        reviewedFiles.delete(item.fileDiff.name);
      }
      saveReviewedFiles(reviewedSourceKeyRef.current, reviewedFiles);

      const instance = viewer.getInstance();
      const itemTop = instance?.getTopForItem(itemId);
      item.collapsed = reviewed;
      incrementItemVersion(item);
      if (!viewer.updateItem(item)) {
        return;
      }
      if (
        reviewed &&
        instance != null &&
        itemTop != null &&
        itemTop < instance.getScrollTop()
      ) {
        viewer.scrollTo({ type: 'item', id: itemId, align: 'start' });
      }
    }
  );

  const getLoadedItemIds = useStableCallback(
    (): ReadonlySet<string> => loadedItemIdsRef.current
  );

  const cancelLineHashSettleRef = useRef<(() => void) | null>(null);

  const tryApplyLineHashTarget = useStableCallback(() => {
    const { hash } = window.location;
    const target = parseDiffsHubLineHash(hash);
    if (target == null) {
      return;
    }

    const applyKey = getLineHashApplyKey(viewerKeyRef.current, hash);
    if (appliedLineHashKeyRef.current === applyKey) {
      return;
    }

    const viewer = viewerRef.current;
    if (viewer == null) {
      return;
    }

    const applied = applyDiffsHubLineHashTarget(viewer, target);
    if (applied !== 'unapplied') {
      appliedLineHashKeyRef.current = applyKey;
    }
    if (applied === 'applied') {
      settleLineHashScroll(target);
    }
  });

  // Re-issues the restore scroll for a short window after the first apply.
  // The initial scroll fires while the page is still settling — virtualized
  // neighbors re-measure as they mount, review threads inject annotation
  // height once they load, and rendered markdown documents fetch their full
  // contents and re-measure — all of which shift the target away from a
  // one-shot scroll. Any manual scroll input cancels the loop immediately.
  const settleLineHashScroll = useStableCallback(
    (
      target: DiffsHubLineHashTarget,
      behavior: 'instant' | 'smooth' = 'instant'
    ) => {
      cancelLineHashSettleRef.current?.();
      cancelDocTargetScroll();
      let ticks = 0;
      let timer: number | undefined;
      const cleanup = () => {
        if (timer != null) {
          window.clearTimeout(timer);
        }
        for (const type of LINE_HASH_SETTLE_CANCEL_EVENTS) {
          window.removeEventListener(type, cleanup, true);
        }
        if (cancelLineHashSettleRef.current === cleanup) {
          cancelLineHashSettleRef.current = null;
        }
      };
      cancelLineHashSettleRef.current = cleanup;
      for (const type of LINE_HASH_SETTLE_CANCEL_EVENTS) {
        window.addEventListener(type, cleanup, {
          capture: true,
          passive: true,
        });
      }
      const tick = () => {
        const viewer = viewerRef.current;
        if (viewer == null || ++ticks > 8) {
          cleanup();
          return;
        }
        if (target.range == null) {
          // getTopForItem returns the exact offset scrollTo(align: 'start')
          // targets, so skip the re-issue once the viewer already sits there
          // — the loop only acts while late-measuring content is still
          // shifting the item.
          const instance = viewer.getInstance();
          const itemTop = instance?.getTopForItem(target.itemId);
          if (
            instance == null ||
            itemTop == null ||
            Math.abs(itemTop - instance.getScrollTop()) > 1
          ) {
            viewer.scrollTo({
              type: 'item',
              id: target.itemId,
              align: 'start',
              behavior,
            });
          }
        } else {
          viewer.scrollTo({
            type: 'range',
            id: target.itemId,
            range: target.range,
            align: 'center',
            behavior,
          });
        }
        timer = window.setTimeout(tick, 300);
      };
      timer = window.setTimeout(tick, 300);
    }
  );

  // Scrolls a file to the top of the viewer for a file-tree or file-header
  // click. A one-shot scroll lands short on markdown items whose rendered
  // document materializes after the click, so this re-anchors through the
  // same settle loop the hash restore uses; smooth re-issues blend into the
  // in-flight scroll animation instead of restarting it.
  const scrollToItem = useStableCallback((itemId: string) => {
    viewerRef.current?.scrollTo({
      type: 'item',
      id: itemId,
      align: 'start',
      behavior: 'smooth',
    });
    settleLineHashScroll({ itemId, range: null }, 'smooth');
  });

  // Writes a hash into the URL (via replaceState, so no history entry) and
  // marks it as already applied so the restore path doesn't scroll-jump the
  // view the user is currently looking at.
  const recordLineHash = useStableCallback((hash: string | null) => {
    // A new navigation supersedes any still-settling restore or document
    // scroll.
    cancelLineHashSettleRef.current?.();
    cancelDocTargetScroll();
    appliedLineHashKeyRef.current =
      hash == null ? null : getLineHashApplyKey(viewerKeyRef.current, hash);
    replaceLocationHash(hash);
  });

  const handleLineLinkChange = useStableCallback(
    (selection: CodeViewLineSelection | null) => {
      recordLineHash(
        selection == null ? null : formatDiffsHubLineHash(selection)
      );
    }
  );

  // Persists a navigation target (a file-tree or sidebar-comment click) so a
  // refresh restores the same place: file-only targets scroll the file into
  // view, ranged targets also restore the line selection.
  const recordViewTarget = useStableCallback(
    (itemId: string, range?: SelectedLineRange) => {
      recordLineHash(
        range == null
          ? formatDiffsHubItemHash(itemId)
          : formatDiffsHubLineHash({ id: itemId, range })
      );
    }
  );

  useEffect(() => {
    if (!tokenHydrated) {
      return;
    }
    const patchRequestKey =
      domain == null || domain === '' ? path : `${domain}${path}`;
    const patchSearchParams = new URLSearchParams({ path });
    if (domain != null && domain !== '') {
      patchSearchParams.set('domain', domain);
    }

    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    const isCurrentRequest = () =>
      requestIdRef.current === requestId && !controller.signal.aborted;

    viewerKeyRef.current = requestId;
    appliedLineHashKeyRef.current = null;
    loadedItemIdsRef.current = new Set();
    hiddenItemIdsRef.current = NO_HIDDEN_ITEM_IDS;
    filterCollapsedIdsRef.current = new Set();
    reviewedSourceKeyRef.current = patchRequestKey;
    reviewedFilesRef.current = loadReviewedFiles(patchRequestKey);
    setViewerKey(requestId);
    setInitialItems([]);
    setTreeSource(null);
    setDiffStats(null);
    setCommentFileByItemId(null);
    setCommentSections([]);
    onLoadStart();
    setErrorMessage(null);
    setLoadState('fetching');

    async function loadPatch() {
      try {
        const cacheKeyPrefix = encodeURIComponent(patchRequestKey);
        async function commitFullPatch(patchContent: string) {
          if (!isCurrentRequest()) {
            return;
          }
          setLoadState('parsing');
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

          if (!isCurrentRequest()) {
            return;
          }
          const loadedData = buildDiffsHubData(patchContent, patchRequestKey);
          if (!isCurrentRequest()) {
            return;
          }

          setTreeSource(loadedData.treeSource);
          setCommentFileByItemId(loadedData.itemIdToFile);
          setCommentSections([]);
          setDiffStats(loadedData.diffStats);
          prepareItemsForViewer(loadedData.items);
          setInitialItems(loadedData.items);
          setLoadState('ready');
          await yieldToBrowser();
          if (isCurrentRequest()) {
            tryApplyLineHashTarget();
          }
        }

        const response = await fetchReportingRejection(
          `/api/diff?${patchSearchParams}`,
          createPatchRequestInit(
            controller.signal,
            domain == null || domain === '' ? getGitHubToken?.() : undefined
          )
        );

        // This only catches route setup errors. GitHub fetch failures are
        // delivered while consuming the stream so the UI can enter the
        // streaming state as soon as the local transport opens.
        if (!response.ok) {
          const detail = (await response.text()).trim();
          throw new Error(
            detail.length > 0 ? detail : `Request failed (${response.status}).`
          );
        }

        if (response.body == null) {
          const patchContent = await response.text();
          await commitFullPatch(patchContent);
          return;
        }

        setLoadState('streaming');
        await yieldToBrowser();
        if (!isCurrentRequest()) {
          return;
        }

        const accumulator = createDiffsHubDataAccumulator();
        let streamPatchIndex = 0;
        let streamTreePathPrefix: string | undefined;
        let pendingPublishFileCount = 0;
        let pendingTreePublishFileCount = 0;
        let hasPublishedTree = false;
        let hasPublishedInitialItems = false;
        let hasReceivedFirstStreamedFile = false;
        let lastPublishTime = performance.now();
        let lastWorkYieldTime = lastPublishTime;
        let lastTreePublishTime = lastPublishTime;
        const initialPublishFileBatchSize = getInitialBatchSize();

        const publishTreeSource = () => {
          if (pendingTreePublishFileCount === 0 || !isCurrentRequest()) {
            return;
          }

          pendingTreePublishFileCount = 0;
          hasPublishedTree = true;
          lastTreePublishTime = performance.now();
          setCommentFileByItemId(accumulator.itemIdToFile);
          setDiffStats({ ...accumulator.diffStats });
          setTreeSource(snapshotDiffsHubTreeSource(accumulator));
        };

        const publishPendingData = async () => {
          if (pendingPublishFileCount === 0 || !isCurrentRequest()) {
            return;
          }

          pendingPublishFileCount = 0;
          lastPublishTime = performance.now();
          const pendingItems = takePendingDiffsHubItems(accumulator);
          prepareItemsForViewer(pendingItems);
          if (!hasPublishedInitialItems) {
            hasPublishedInitialItems = true;
            publishTreeSource();
            setInitialItems(pendingItems);
          } else {
            const viewer = viewerRef.current;
            if (viewer != null) {
              viewer.addItems(pendingItems);
            } else {
              setInitialItems((prev) => [...prev, ...pendingItems]);
            }
          }
          await yieldToBrowser();
          if (isCurrentRequest()) {
            tryApplyLineHashTarget();
          }
          lastWorkYieldTime = performance.now();
        };

        const publishPendingDataIfNeeded = async () => {
          if (pendingPublishFileCount === 0) {
            return;
          }

          const elapsed = performance.now() - lastPublishTime;
          const publishFileBatchSize = hasPublishedInitialItems
            ? CODE_VIEW_BATCH_COUNT
            : initialPublishFileBatchSize;
          const publishInterval = hasPublishedInitialItems
            ? STREAM_PUBLISH_INTERVAL_MS
            : STREAM_INITIAL_PUBLISH_INTERVAL_MS;
          if (
            pendingPublishFileCount < publishFileBatchSize &&
            elapsed < publishInterval
          ) {
            return;
          }

          await publishPendingData();
        };
        const shouldDeferInitialPublishForBatchTarget = () => {
          if (hasPublishedInitialItems) {
            return false;
          }

          const elapsed = performance.now() - lastPublishTime;
          return (
            pendingPublishFileCount < initialPublishFileBatchSize &&
            elapsed < STREAM_INITIAL_PUBLISH_INTERVAL_MS
          );
        };
        const publishTreeSourceIfNeeded = () => {
          if (pendingTreePublishFileCount === 0) {
            return;
          }

          const elapsed = performance.now() - lastTreePublishTime;
          if (
            hasPublishedTree &&
            pendingTreePublishFileCount < STREAM_TREE_PUBLISH_FILE_BATCH_SIZE &&
            elapsed < STREAM_TREE_PUBLISH_INTERVAL_MS
          ) {
            return;
          }

          publishTreeSource();
        };
        const appendStreamedFile = async (fileText: string) => {
          if (!hasReceivedFirstStreamedFile) {
            hasReceivedFirstStreamedFile = true;
          }

          const patchMetadata = getStreamedPatchMetadata(fileText);
          if (patchMetadata != null) {
            streamTreePathPrefix = getPatchTreePathPrefix(
              patchMetadata,
              streamPatchIndex++
            );
          }

          const fileDiff = processFile(fileText, {
            cacheKey: `${cacheKeyPrefix}-0-${accumulator.fileIndex}`,
            isGitDiff: true,
          });
          if (fileDiff == null) {
            return;
          }

          const itemIdRename = appendFileDiffToDiffsHubData(
            accumulator,
            fileDiff,
            streamTreePathPrefix
          );
          if (itemIdRename != null) {
            applyDiffsHubItemIdRename(viewerRef.current, itemIdRename);
            if (loadedItemIdsRef.current.delete(itemIdRename.oldId)) {
              loadedItemIdsRef.current.add(itemIdRename.newId);
            }
            if (filterCollapsedIdsRef.current.delete(itemIdRename.oldId)) {
              filterCollapsedIdsRef.current.add(itemIdRename.newId);
            }
          }
          pendingPublishFileCount++;
          pendingTreePublishFileCount++;
          const elapsedWork = performance.now() - lastWorkYieldTime;
          if (elapsedWork >= STREAM_WORK_BUDGET_MS) {
            if (shouldDeferInitialPublishForBatchTarget()) {
              await yieldToBrowser();
              lastWorkYieldTime = performance.now();
            } else {
              await publishPendingData();
            }
          } else {
            await publishPendingDataIfNeeded();
          }
          publishTreeSourceIfNeeded();
        };

        const fallbackPatchContent = await streamGitPatchFiles(
          response.body,
          appendStreamedFile
        );
        if (!isCurrentRequest()) {
          return;
        }

        await publishPendingData();
        publishTreeSource();
        if (fallbackPatchContent != null) {
          await commitFullPatch(fallbackPatchContent);
          return;
        }

        setCommentFileByItemId(new Map(accumulator.itemIdToFile));
        setDiffStats({ ...accumulator.diffStats });
        setLoadState('ready');
      } catch (error) {
        if (!isCurrentRequest()) {
          return;
        }
        setErrorMessage(getPatchLoadErrorMessage(error));
        setLoadState('error');
      }
    }

    void loadPatch();

    return () => {
      controller.abort();
    };
  }, [
    domain,
    getGitHubToken,
    githubTokenVersion,
    loadAttempt,
    onLoadStart,
    path,
    tokenHydrated,
    tryApplyLineHashTarget,
    viewerRef,
  ]);

  useEffect(() => {
    window.addEventListener('hashchange', tryApplyLineHashTarget);
    tryApplyLineHashTarget();
    return () => {
      window.removeEventListener('hashchange', tryApplyLineHashTarget);
    };
  }, [tryApplyLineHashTarget]);

  const retryLoad = useCallback(() => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  return {
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
    onLineLinkChange: handleLineLinkChange,
    onViewerReady: tryApplyLineHashTarget,
    recordViewTarget,
    retryLoad,
    scrollToItem,
    setCommentSections,
    setFileReviewed,
    treeSource,
    viewerKey,
  };
}

function getLineHashApplyKey(viewerKey: number, hash: string): string {
  return `${viewerKey}:${hash}`;
}

// How applying a hash target went: not yet possible (the item is not loaded),
// applied and in need of the settle loop, or handed to the doc-target scroll
// loop, which settles on its own while a rendered document is open.
type LineHashApplyResult = 'unapplied' | 'applied' | 'doc-scroll';

function applyDiffsHubLineHashTarget(
  viewer: CodeViewHandle<CommentMetadata>,
  target: DiffsHubLineHashTarget
): LineHashApplyResult {
  const item = viewer.getItem(target.itemId);
  if (item == null) {
    return 'unapplied';
  }

  const selectedLines = viewer.getSelectedLines();
  const alreadySelected =
    target.range != null &&
    selectedLines?.id === target.itemId &&
    areSelectionsEqual(selectedLines.range, target.range);
  const docDiff = getOpenDocDiff(item);
  if (alreadySelected && docDiff == null) {
    return 'applied';
  }

  if (item.collapsed === true) {
    item.collapsed = false;
    incrementItemVersion(item);
    if (!viewer.updateItem(item)) {
      return 'unapplied';
    }
    viewer.getInstance()?.render(true);
  }

  if (target.range == null) {
    viewer.scrollTo({
      type: 'item',
      id: target.itemId,
      align: 'start',
      behavior: 'instant',
    });
    return 'applied';
  }

  if (!alreadySelected) {
    viewer.setSelectedLines({ id: target.itemId, range: target.range });
  }
  const { range } = target;
  const scrollToRange = () =>
    viewer.scrollTo({
      type: 'range',
      id: target.itemId,
      range,
      align: 'center',
      behavior: 'instant',
    });
  // While the item's rendered markdown document is open the range's rows are
  // hidden, so center the document block holding the range's end instead,
  // falling back to the range when the document failed to render.
  if (docDiff != null) {
    scrollDocTargetIntoView(
      viewer,
      target.itemId,
      docLineTarget(docDiff, {
        itemId: target.itemId,
        side: range.endSide ?? range.side ?? 'additions',
        lineNumber: range.end,
      }),
      scrollToRange
    );
    return 'doc-scroll';
  }
  scrollToRange();
  return 'applied';
}

function applyDiffsHubItemIdRename(
  viewer: CodeViewHandle<CommentMetadata> | null,
  rename: DiffsHubItemIdRename
): void {
  viewer?.updateItemId(rename.oldId, rename.newId);
}

function createPatchRequestInit(
  signal: AbortSignal,
  token: string | undefined
): RequestInit {
  const normalizedToken = token?.trim();
  if (normalizedToken == null || normalizedToken === '') {
    return { cache: 'no-store', signal };
  }
  return {
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    signal,
  };
}

function getPatchLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return GENERIC_PATCH_LOAD_ERROR_MESSAGE;
}

function replaceLocationHash(hash: string | null): void {
  const { pathname, search } = window.location;
  const nextHash = hash ?? '';
  if (window.location.hash === nextHash) {
    return;
  }

  window.history.replaceState(
    window.history.state,
    '',
    `${pathname}${search}${nextHash}`
  );
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    let didResolve = false;
    const resolveOnce = () => {
      if (didResolve) {
        return;
      }

      didResolve = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(resolveOnce, 50);
    window.requestAnimationFrame(resolveOnce);
  });
}
