'use client';

import { useStableCallback } from '@pierre/diffs/react';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import type { DiffFindBar, DiffFindRequest } from './DiffFindBar';
import { EMPTY_DIFF_SEARCH_QUERY } from './DiffSearchInput';
import {
  DiffSearchPanel,
  type DiffSearchPinnedResults,
} from './DiffSearchPanel';
import type { SymbolNavigateRequest, SymbolTarget } from './DiffsHubViewer';
import type { DiffSearchController } from './useDiffSearchController';
import { useSymbolHoverPreview } from './useSymbolHoverPreview';
import type { DiffLocation, DiffSearchQuery } from '@/lib/diffSearch';
import { NavigationHistory } from '@/lib/navigationHistory';
import { getNavigateBackShortcutLabel, isMacPlatform } from '@/lib/platform';
import { findSymbolDefinitions, isSameLine } from '@/lib/symbolSearch';

// How long the highlight on a jumped-to location stays up.
const SYMBOL_HIGHLIGHT_MS = 2_000;
// Longest selection that seeds a find query; anything longer is almost
// certainly a multi-line copy rather than a search term.
const MAX_SEED_LENGTH = 200;

type FindBarProps = Omit<ComponentProps<typeof DiffFindBar>, 'className'>;

interface UseDiffSearchUIOptions {
  controller: DiffSearchController;
  // Called whenever the search tab is requested, so mobile can open the
  // sidebar overlay that hosts it.
  onOpenSearchTab(): void;
}

interface DiffSearchUI {
  // Props for the find bar, or null while it is closed.
  findBarProps: FindBarProps | null;
  handleSymbolHover(target: SymbolTarget | null, event: PointerEvent): void;
  handleSymbolNavigate(request: SymbolNavigateRequest): void;
  renderSearchPanel(visible: boolean): ReactNode;
  searchTabRequest: number;
  // The Cmd/Ctrl-hover definition card (portaled), or null.
  symbolPreview: ReactNode;
}

// State and shortcuts for in-app search in the diff viewer:
//  - Cmd/Ctrl+F opens the find bar on the file at the top of the viewport.
//    Pressing it again while the bar's field is focused falls through to the
//    browser's native find, the same escape hatch GitHub offers.
//  - Cmd/Ctrl+Shift+F opens the sidebar's search-all-files panel.
//  - Cmd/Ctrl-click on an identifier jumps to its definition (listing every
//    candidate when there are several); Cmd/Ctrl+Shift-click lists usages.
//    Cmd/Ctrl-hover previews the definition.
//  - Alt+Left / Alt+Right (plus Ctrl+- / Ctrl+Shift+- on macOS, as in VS
//    Code) walk back and forward through those jumps.
// Both search shortcuts seed the query with the current text selection.
export function useDiffSearchUI({
  controller,
  onOpenSearchTab,
}: UseDiffSearchUIOptions): DiffSearchUI {
  const [findOpen, setFindOpen] = useState(false);
  const [findRequest, setFindRequest] = useState<DiffFindRequest>({
    id: 0,
    itemId: null,
  });
  const [findQuery, setFindQuery] = useState(EMPTY_DIFF_SEARCH_QUERY);
  const [panelQuery, setPanelQuery] = useState(EMPTY_DIFF_SEARCH_QUERY);
  const [pinned, setPinned] = useState<DiffSearchPinnedResults | null>(null);
  const [searchTabRequest, setSearchTabRequest] = useState(0);
  const [history] = useState(() => new NavigationHistory<DiffLocation>());
  const symbolHighlightTimerRef = useRef<number | undefined>(undefined);
  const backHintShownRef = useRef(false);
  const hover = useSymbolHoverPreview(controller);

  useEffect(
    () => () => window.clearTimeout(symbolHighlightTimerRef.current),
    []
  );

  // Shows a query (and optionally a pinned list) in the search panel.
  const showInPanel = useStableCallback(
    (
      query: DiffSearchQuery | null,
      pinnedResults: DiffSearchPinnedResults | null
    ) => {
      if (query != null) {
        setPanelQuery(query);
      }
      setPinned(pinnedResults);
      setSearchTabRequest((request) => request + 1);
      onOpenSearchTab();
    }
  );

  const openFind = useStableCallback(() => {
    const text = getSelectionSeed();
    if (text != null) {
      setFindQuery((query) => ({ ...query, text }));
    }
    setFindRequest((request) => ({
      id: request.id + 1,
      itemId: controller.getItemIdAtViewportTop(),
    }));
    setFindOpen(true);
  });

  const openSearchAll = useStableCallback((query?: DiffSearchQuery) => {
    const text = getSelectionSeed();
    showInPanel(query ?? (text == null ? null : { ...panelQuery, text }), null);
  });

  // Scrolls to a location and briefly highlights the symbol there.
  const flashLocation = useStableCallback((location: DiffLocation) => {
    controller.navigateTo(location);
    controller.showMatches('symbol', [location], location);
    window.clearTimeout(symbolHighlightTimerRef.current);
    symbolHighlightTimerRef.current = window.setTimeout(
      () => controller.clearMatches('symbol'),
      SYMBOL_HIGHLIGHT_MS
    );
  });

  // Applies a history step; false when there was nowhere to go.
  const jumpTo = useStableCallback((target: DiffLocation | null) => {
    if (target != null) {
      flashLocation(target);
    }
    return target != null;
  });

  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && !event.altKey && event.code === 'KeyF') {
        if (event.shiftKey) {
          event.preventDefault();
          openSearchAll();
        } else if (!isFindBarFocused()) {
          // A second press from inside the bar falls through to the
          // browser's find.
          event.preventDefault();
          openFind();
        }
        return;
      }
      // Alt+Arrow moves by word in text fields; leave those alone.
      if (isEditableEventTarget(event)) {
        return;
      }
      const altArrow =
        event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
      const ctrlMinus =
        mac &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.code === 'Minus';
      const back =
        (altArrow && event.key === 'ArrowLeft') ||
        (ctrlMinus && !event.shiftKey);
      const forward =
        (altArrow && event.key === 'ArrowRight') ||
        (ctrlMinus && event.shiftKey);
      // Only claim the keys (which double as browser history shortcuts on
      // some platforms) when there is somewhere to go.
      if (
        (back && jumpTo(history.goBack())) ||
        (forward && jumpTo(history.goForward()))
      ) {
        event.preventDefault();
      }
    };
    // Bubble phase, so an inline editor that handles its own Cmd/Ctrl+F
    // (and marks the event handled) keeps it.
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [history, jumpTo, openFind, openSearchAll]);

  const handleSymbolNavigate = useStableCallback(
    (request: SymbolNavigateRequest) => {
      hover.dismiss();
      const origin: DiffLocation = {
        itemId: request.itemId,
        side: request.side,
        lineNumber: request.lineNumber,
        start: request.start,
        end: request.start + request.name.length,
      };
      const usagesQuery: DiffSearchQuery = {
        text: request.name,
        caseSensitive: true,
        wholeWord: true,
        regex: false,
      };
      // Lists land in the search panel, so those jumps have an origin to
      // return to but no single destination.
      const showList = (pinnedResults: DiffSearchPinnedResults | null) => {
        history.push(origin, null);
        showInPanel(usagesQuery, pinnedResults);
      };
      if (request.action === 'usages') {
        showList(null);
        return;
      }
      const definitions = findSymbolDefinitions(
        controller.getSources(),
        request.name
      );
      if (definitions.length === 0) {
        toast(`No definition of ${request.name} found in this diff`, {
          description:
            controller.partialFileCount > 0
              ? 'Showing usages. Including unchanged lines in the search panel may find it.'
              : 'Showing usages instead.',
        });
        showList(null);
        return;
      }
      // Cmd-clicking a definition itself lists its usages, as in editors.
      if (definitions.some((definition) => isSameLine(definition, request))) {
        showList(null);
        return;
      }
      if (definitions.length > 1) {
        showList({
          title: `${definitions.length} definitions of ${request.name}`,
          matches: definitions,
        });
        return;
      }
      const [definition] = definitions;
      history.push(origin, definition);
      flashLocation(definition);
      // Point out the way back once per session.
      if (!backHintShownRef.current) {
        backHintShownRef.current = true;
        toast(`Jumped to ${request.name}`, {
          description: `Press ${getNavigateBackShortcutLabel()} to go back.`,
          action: { label: 'Back', onClick: () => jumpTo(history.goBack()) },
        });
      }
    }
  );

  const closeFind = useCallback(() => setFindOpen(false), []);
  const clearPinned = useCallback(() => setPinned(null), []);

  const renderSearchPanel = useCallback(
    (visible: boolean) => (
      <DiffSearchPanel
        controller={controller}
        focusRequest={searchTabRequest}
        pinned={pinned}
        query={panelQuery}
        setQuery={setPanelQuery}
        visible={visible}
        onClearPinned={clearPinned}
      />
    ),
    [clearPinned, controller, panelQuery, pinned, searchTabRequest]
  );

  return {
    findBarProps: findOpen
      ? {
          controller,
          onClose: closeFind,
          onSearchAll: openSearchAll,
          query: findQuery,
          request: findRequest,
          setQuery: setFindQuery,
        }
      : null,
    handleSymbolHover: hover.onSymbolHover,
    handleSymbolNavigate,
    renderSearchPanel,
    searchTabRequest,
    symbolPreview: hover.preview,
  };
}

// The current text selection, when it is short and single-line enough to be
// a search term. Selections inside the viewer's shadow roots are still
// reported by the document selection in current browsers.
function getSelectionSeed(): string | null {
  const text = document.getSelection()?.toString() ?? '';
  if (text === '' || text.length > MAX_SEED_LENGTH || /[\r\n]/.test(text)) {
    return null;
  }
  return text;
}

function isFindBarFocused(): boolean {
  return (
    document.activeElement?.closest(
      '[role="search"][aria-label="Find in file"]'
    ) != null
  );
}

function isEditableEventTarget(event: KeyboardEvent): boolean {
  const [target] = event.composedPath();
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable]') != null
  );
}
