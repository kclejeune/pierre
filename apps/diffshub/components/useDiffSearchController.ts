'use client';

import {
  canHydrateDiff,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  hydratePartialDiff,
} from '@pierre/diffs';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { DiffLocation, DiffSearchSource } from '@/lib/diffSearch';
import { incrementItemVersion } from '@/lib/incrementItemVersion';
import { DiffSearchHighlighter } from '@/lib/searchHighlights';
import type { CommentMetadata } from '@/lib/types';

const FULL_FILE_LOAD_CONCURRENCY = 6;
// Full files landing one at a time would otherwise re-run an open search
// once per file; progress is published at most this often instead.
const FULL_FILE_PUBLISH_INTERVAL_MS = 250;
const NAVIGATE_TICK_MS = 120;
const NAVIGATE_MAX_TICKS = 40;
// Sticky file headers cover the top of the viewport; an item counts as "on
// screen" only once its body reaches below them.
const VIEWPORT_TOP_INSET_PX = 48;

// Each source of highlights paints its own layer: the find bar (Ctrl+F), the
// search panel (Ctrl+Shift+F), and the brief flash on a jumped-to symbol.
type HighlightLayer = 'find' | 'panel' | 'symbol';

interface FullFileLoadState {
  status: 'idle' | 'loading' | 'done';
  loaded: number;
  total: number;
  failed: number;
}

const IDLE_FULL_FILES: FullFileLoadState = {
  status: 'idle',
  loaded: 0,
  total: 0,
  failed: 0,
};

export interface DiffSearchController {
  fullFiles: FullFileLoadState;
  // Patch-only files that full-file loading would upgrade; 0 when this diff
  // has no loader.
  partialFileCount: number;
  // Every loaded file, searchable form. Its identity changes whenever the
  // searchable content does (files streaming in, full files landing), so
  // result lists can memoize on it.
  getSources(): DiffSearchSource[];
  getSource(itemId: string): DiffSearchSource | undefined;
  getItemIdAtViewportTop(): string | null;
  loadFullFiles(): void;
  navigateTo(location: DiffLocation): void;
  showMatches(
    layer: HighlightLayer,
    matches: readonly DiffLocation[],
    active: DiffLocation | null
  ): void;
  clearMatches(layer: HighlightLayer): void;
  // Re-paints highlights after the viewer re-renders rows.
  refreshHighlights(): void;
  // Call when the viewer instance becomes ready (or is replaced).
  attachViewer(): void;
}

interface UseDiffSearchControllerOptions {
  getLoadedItemIds(): ReadonlySet<string>;
  loadDiffFiles?: FileDiffContentsLoader;
  // Changes whenever the viewer's item list grows (the streamed tree source).
  itemsVersion: unknown;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
}

// Shared plumbing for the find bar and the cross-file search panel:
// enumerates searchable file diffs, optionally loads full file contents so
// unchanged lines become searchable, paints match highlights, and scrolls the
// viewer to a match (expanding collapsed files and context as needed).
export function useDiffSearchController({
  getLoadedItemIds,
  itemsVersion,
  loadDiffFiles,
  viewerRef,
}: UseDiffSearchControllerOptions): DiffSearchController {
  const [hydrationVersion, setHydrationVersion] = useState(0);
  // Bumped when the viewer instance (re)mounts, since sources read it.
  const [viewerGeneration, setViewerGeneration] = useState(0);
  const [fullFiles, setFullFiles] = useState(IDLE_FULL_FILES);
  // Full-file copies used only for searching, keyed by the viewer's own diff
  // object. The viewer keeps rendering its partial diff and hydrates it
  // itself (through the same cached loader) when a match needs expanding.
  const hydratedRef = useRef(new WeakMap<FileDiffMetadata, FileDiffMetadata>());
  const cancelNavigateRef = useRef<(() => void) | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const [highlighters] = useState(() => {
    const getInstance = () => viewerRef.current?.getInstance();
    return {
      find: new DiffSearchHighlighter('find', getInstance),
      panel: new DiffSearchHighlighter('panel', getInstance),
      symbol: new DiffSearchHighlighter('symbol', getInstance),
    } satisfies Record<HighlightLayer, DiffSearchHighlighter>;
  });

  const scheduleHighlights = useStableCallback(() => {
    for (const highlighter of Object.values(highlighters)) {
      highlighter.schedule();
    }
  });

  useEffect(
    () => () => {
      for (const highlighter of Object.values(highlighters)) {
        highlighter.dispose();
      }
      cancelNavigateRef.current?.();
      loadAbortRef.current?.abort();
    },
    [highlighters]
  );

  // The diff search reads: the viewer's partial diff, or the full-file copy
  // once one was loaded. A copy is dropped as soon as the viewer hydrated its
  // own diff, which then already holds the full file.
  const toSource = useCallback(
    (itemId: string): DiffSearchSource | undefined => {
      const item = viewerRef.current?.getItem(itemId);
      if (item?.type !== 'diff') {
        return undefined;
      }
      const { fileDiff } = item;
      if (!fileDiff.isPartial) {
        hydratedRef.current.delete(fileDiff);
      }
      return {
        itemId,
        path: fileDiff.name,
        fileDiff: hydratedRef.current.get(fileDiff) ?? fileDiff,
      };
    },
    [viewerRef]
  );

  // The version inputs are change signals for data read through refs.
  const contentVersion = `${String(viewerGeneration)}:${String(hydrationVersion)}`;
  const getSources = useCallback((): DiffSearchSource[] => {
    void contentVersion;
    void itemsVersion;
    const sources: DiffSearchSource[] = [];
    for (const id of getLoadedItemIds()) {
      const source = toSource(id);
      if (source != null) {
        sources.push(source);
      }
    }
    return sources;
  }, [contentVersion, getLoadedItemIds, itemsVersion, toSource]);

  const getPartialFiles = (): FileDiffMetadata[] => {
    const partial: FileDiffMetadata[] = [];
    for (const id of getLoadedItemIds()) {
      const item = viewerRef.current?.getItem(id);
      if (
        item?.type === 'diff' &&
        canHydrateDiff(item.fileDiff) &&
        !hydratedRef.current.has(item.fileDiff)
      ) {
        partial.push(item.fileDiff);
      }
    }
    return partial;
  };

  const partialFileCount = useMemo(
    () =>
      loadDiffFiles == null ? 0 : getSources().filter(isPartialSource).length,
    [getSources, loadDiffFiles]
  );

  // Fetches full old/new contents for every patch-only file through the
  // viewer's loader (which caches per file, so later expansions reuse the
  // response) and keeps hydrated copies for search. Runs a few requests at a
  // time and publishes progress in batches as files land.
  const loadFullFiles = useStableCallback(() => {
    if (loadDiffFiles == null || fullFiles.status === 'loading') {
      return;
    }
    const queue = getPartialFiles();
    if (queue.length === 0) {
      setFullFiles((state) => ({ ...state, status: 'done' }));
      return;
    }
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const total = queue.length;
    let loaded = 0;
    let failed = 0;
    let publishTimer: number | undefined;
    const publish = () => {
      publishTimer = undefined;
      setFullFiles({ status: 'loading', loaded, total, failed });
      setHydrationVersion((version) => version + 1);
    };
    setFullFiles({ status: 'loading', loaded, total, failed });
    const worker = async () => {
      while (queue.length > 0 && !controller.signal.aborted) {
        const fileDiff = queue.shift();
        if (fileDiff == null) {
          return;
        }
        try {
          const files = await loadDiffFiles(fileDiff);
          if (controller.signal.aborted) {
            return;
          }
          // The viewer may have hydrated its own diff in the meantime.
          if (fileDiff.isPartial) {
            hydratedRef.current.set(
              fileDiff,
              hydratePartialDiff('clone', fileDiff, files)
            );
          }
          loaded++;
        } catch {
          failed++;
        }
        publishTimer ??= window.setTimeout(
          publish,
          FULL_FILE_PUBLISH_INTERVAL_MS
        );
      }
    };
    void Promise.all(
      Array.from({ length: FULL_FILE_LOAD_CONCURRENCY }, worker)
    ).then(() => {
      window.clearTimeout(publishTimer);
      if (!controller.signal.aborted) {
        setFullFiles({ status: 'done', loaded, total, failed });
        setHydrationVersion((version) => version + 1);
      }
    });
  });

  // A new diff (viewer remount) starts with nothing loaded.
  useEffect(() => {
    loadAbortRef.current?.abort();
    setFullFiles(IDLE_FULL_FILES);
  }, [loadDiffFiles]);

  // The item whose body sits at the top of the viewport, below the sticky
  // header: the file the find bar searches.
  const getItemIdAtViewportTop = useStableCallback((): string | null => {
    const instance = viewerRef.current?.getInstance();
    const container = instance?.getContainerElement();
    if (instance == null || container == null) {
      return null;
    }
    const top = container.getBoundingClientRect().top + VIEWPORT_TOP_INSET_PX;
    let fallback: string | null = null;
    for (const rendered of instance.getRenderedItems()) {
      if (rendered.element.getBoundingClientRect().bottom > top) {
        return rendered.id;
      }
      fallback = rendered.id;
    }
    return fallback;
  });

  // Scrolls a location into the middle of the viewport. Collapsed files are
  // expanded first; locations in collapsed context (only possible after full
  // files were loaded) are revealed through CodeView.revealLine, which may
  // need the viewer to hydrate the file and re-layout before the row exists,
  // so the scroll is re-issued on a short timer until the line is renderable
  // and has stopped moving. Wheel or touch input cancels it.
  const navigateTo = useStableCallback((location: DiffLocation) => {
    cancelNavigateRef.current?.();
    const viewer = viewerRef.current;
    const item = viewer?.getItem(location.itemId);
    if (viewer == null || item == null) {
      return;
    }
    if (item.collapsed === true) {
      item.collapsed = false;
      incrementItemVersion(item);
      viewer.updateItem(item);
      viewer.getInstance()?.render(true);
    }
    const scroll = (behavior: 'instant' | 'smooth-auto') => {
      viewer.scrollTo({
        type: 'line',
        id: location.itemId,
        lineNumber: location.lineNumber,
        side: location.side,
        align: 'center',
        behavior,
      });
    };
    const isRenderable = () =>
      location.side === 'deletions' ||
      (viewer.getInstance()?.revealLine(location.itemId, location.lineNumber) ??
        false);
    if (isRenderable()) {
      scroll('smooth-auto');
      scheduleHighlights();
      return;
    }

    let ticks = 0;
    let readyTicks = 0;
    let timer: number | undefined;
    const listeners = new AbortController();
    const cleanup = () => {
      window.clearTimeout(timer);
      listeners.abort();
      if (cancelNavigateRef.current === cleanup) {
        cancelNavigateRef.current = null;
      }
    };
    cancelNavigateRef.current = cleanup;
    const listenerOptions = {
      capture: true,
      passive: true,
      signal: listeners.signal,
    };
    window.addEventListener('wheel', cleanup, listenerOptions);
    window.addEventListener('touchstart', cleanup, listenerOptions);
    const tick = () => {
      if (++ticks > NAVIGATE_MAX_TICKS || viewerRef.current !== viewer) {
        cleanup();
        return;
      }
      readyTicks = isRenderable() ? readyTicks + 1 : 0;
      scroll('instant');
      scheduleHighlights();
      // Two consecutive ready ticks: the expansion has been laid out.
      if (readyTicks >= 2) {
        cleanup();
        return;
      }
      timer = window.setTimeout(tick, NAVIGATE_TICK_MS);
    };
    tick();
  });

  const showMatches = useStableCallback(
    (
      layer: HighlightLayer,
      matches: readonly DiffLocation[],
      active: DiffLocation | null
    ) => highlighters[layer].setMatches(matches, active)
  );

  const clearMatches = useStableCallback((layer: HighlightLayer) =>
    highlighters[layer].clear()
  );

  const attachViewer = useStableCallback(() => {
    setViewerGeneration((generation) => generation + 1);
    scheduleHighlights();
  });

  return useMemo(
    () => ({
      attachViewer,
      clearMatches,
      fullFiles,
      getItemIdAtViewportTop,
      getSource: toSource,
      getSources,
      loadFullFiles,
      navigateTo,
      partialFileCount,
      refreshHighlights: scheduleHighlights,
      showMatches,
    }),
    [
      attachViewer,
      clearMatches,
      fullFiles,
      getItemIdAtViewportTop,
      getSources,
      loadFullFiles,
      navigateTo,
      partialFileCount,
      scheduleHighlights,
      showMatches,
      toSource,
    ]
  );
}

function isPartialSource(source: DiffSearchSource): boolean {
  return canHydrateDiff(source.fileDiff);
}
