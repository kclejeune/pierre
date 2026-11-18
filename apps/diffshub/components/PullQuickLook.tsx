'use client';

import type { CodeViewItem } from '@pierre/diffs';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import { IconArrowUpRight, IconX } from '@pierre/icons';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from './Button';
import { ButtonGroup, ButtonGroupItem } from './ButtonGroup';
import { CollapseDiffButton } from './CollapseDiffButton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './Dialog';
import { TONE_TEXT_CLASS } from './PullOverview';
import { PULL_STATE_DISPLAY } from './pullStateDisplay';
import { themeController } from './themeController';
import { ThemedCodeView } from './ThemedCodeView';
import { ThemeSourceProvider } from './ThemeSourceProvider';
import { useGitHubDiffFileLoader } from './useGitHubDiffFileLoader';
import { useGitHubToken } from './useGitHubToken';
import { usePatchLoader } from './usePatchLoader';
import { cn } from '@/lib/cn';
import {
  compileCollapsePatterns,
  loadCollapsePatternsText,
  parseCollapsePatterns,
} from '@/lib/collapsePatterns';
import { CODE_VIEW_CUSTOM_CSS, CODE_VIEW_LAYOUT } from '@/lib/constants';
import {
  DEFAULT_DISPLAY_SETTINGS,
  loadDisplaySettings,
} from '@/lib/displaySettings';
import { pullKey, type PullSummary } from '@/lib/githubPullSummaries';
import { incrementItemVersion } from '@/lib/incrementItemVersion';
import { isEditableEventTarget } from '@/lib/platform';
import type { CommentMetadata } from '@/lib/types';

interface PullQuickLookProps {
  // The open pull's place in the list ("3 / 20"), or null when it isn't
  // among the rows on screen.
  position: { index: number; total: number } | null;
  onClose(): void;
  // Opens the full review page for the pull (a new tab, recorded in recents
  // and the diff view's queue like the preview's Open diff).
  onOpenReview(pull: PullSummary): void;
  // Moves to the previous (-1) or next (1) pull in the list.
  onStep(delta: -1 | 1): void;
  pull: PullSummary;
}

// A read-only look at a pull's diff over the /pulls list, so a reader can
// check a change (a bot's version bump, a one-line fix) without leaving the
// page: J/K step through the list the same way the preview does, and "Open
// full review" goes to the review page for comments, the file tree, and
// review submission. Esc closes it.
export function PullQuickLook({
  onClose,
  onOpenReview,
  onStep,
  position,
  pull,
}: PullQuickLookProps) {
  // J/K (and [ / ]) step while the dialog is open; the list's own keyboard
  // handler stands aside whenever a dialog is up.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableEventTarget(event)
      ) {
        return;
      }
      const delta =
        event.key === 'j' || event.key === ']'
          ? 1
          : event.key === 'k' || event.key === '['
            ? -1
            : 0;
      if (delta !== 0) {
        event.preventDefault();
        onStep(delta);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onStep]);

  const StateIcon = PULL_STATE_DISPLAY[pull.state].Icon;
  const stateClass = PULL_STATE_DISPLAY[pull.state].className;
  // The reader's saved review-page display settings and auto-collapse
  // patterns, read once per open rather than on every J/K step. The quick
  // look has no settings controls beyond split/unified, which it doesn't save.
  const [view] = useState(loadQuickLookView);
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>(
    view.settings.diffStyle ?? 'split'
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Most of the viewport: diffs want width (split view) and height.
        className="flex h-[92dvh] w-[96vw] max-w-[1800px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1800px]"
      >
        <div className="bg-muted/30 flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <StateIcon
            className={cn('size-4 shrink-0', stateClass)}
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <DialogTitle className="truncate text-sm font-medium">
              <span className="text-muted-foreground mr-1.5 font-normal">
                {pull.owner}/{pull.repo}
              </span>
              {pull.title}
            </DialogTitle>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              #{pull.number}
            </span>
          </div>
          <DialogDescription className="sr-only">
            Read-only diff of {pull.owner}/{pull.repo} #{pull.number}. J and K
            move to the next and previous pull request.
          </DialogDescription>
          {position != null && (
            <div
              role="group"
              aria-label="Pull request list"
              className="text-muted-foreground flex shrink-0 items-center text-xs tabular-nums"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={position.index === 0}
                title="Previous pull request (K)"
                aria-label="Previous pull request"
                onClick={() => onStep(-1)}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <span>
                {position.index + 1} / {position.total}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={position.index >= position.total - 1}
                title="Next pull request (J)"
                aria-label="Next pull request"
                onClick={() => onStep(1)}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          )}
          <ButtonGroup
            aria-label="Diff layout"
            // The group defaults to self-start; center it in the header row
            // with the stepper and buttons around it.
            className="shrink-0 self-center"
            size="xs"
            value={diffStyle}
            onValueChange={(value) =>
              setDiffStyle(value === 'unified' ? 'unified' : 'split')
            }
          >
            <ButtonGroupItem value="split" className="h-7 px-2.5">
              Split
            </ButtonGroupItem>
            <ButtonGroupItem value="unified" className="h-7 px-2.5">
              Unified
            </ButtonGroupItem>
          </ButtonGroup>
          <Button
            asChild
            className="h-7 shrink-0 px-2.5"
            size="xs"
            variant="outline"
          >
            <a
              href={pull.viewerPath}
              rel="noopener"
              target="_blank"
              title="Open the full review in a new tab"
              onClick={() => onOpenReview(pull)}
            >
              Open full review
              <IconArrowUpRight className="size-3" />
            </a>
          </Button>
          <Button
            type="button"
            className="size-7 shrink-0 rounded-md"
            size="icon-sm"
            variant="ghost"
            title="Close (Esc)"
            aria-label="Close quick look"
            onClick={onClose}
          >
            <IconX className="size-3.5" />
          </Button>
        </div>
        {/* Keyed by pull: stepping starts a fresh loader and viewer rather
            than streaming one pull's files into another's. */}
        {/* The diff theme names come from the app's theme controller, as on
            the review page; without the provider they resolve empty and no
            highlight theme loads. */}
        <ThemeSourceProvider controller={themeController}>
          <QuickLookDiff
            key={pullKey(pull)}
            diffStyle={diffStyle}
            pull={pull}
            view={view}
          />
        </ThemeSourceProvider>
      </DialogContent>
    </Dialog>
  );
}

function loadQuickLookView() {
  return {
    collapsePatterns: compileCollapsePatterns(
      parseCollapsePatterns(loadCollapsePatternsText())
    ),
    settings: { ...DEFAULT_DISPLAY_SETTINGS, ...loadDisplaySettings() },
  };
}

type QuickLookView = ReturnType<typeof loadQuickLookView>;

// The diff itself: the review page's patch loader and code view, read-only,
// with the viewer's place kept out of the /pulls URL (syncLocationHash).
function QuickLookDiff({
  diffStyle,
  pull,
  view: { collapsePatterns, settings },
}: {
  diffStyle: 'split' | 'unified';
  pull: PullSummary;
  view: QuickLookView;
}) {
  const { hasToken, hydrated, token, tokenVersion } = useGitHubToken();
  const path = pull.viewerPath;
  const { getGitHubToken, loadDiffFiles } = useGitHubDiffFileLoader({
    hasGitHubToken: hasToken,
    path,
    token,
    tokenVersion,
  });
  const viewerRef = useRef<CodeViewHandle<CommentMetadata, undefined> | null>(
    null
  );
  const onLoadStart = useCallback(() => {}, []);
  const {
    diffStats,
    errorMessage,
    initialItems,
    loadState,
    onViewerReady,
    retryLoad,
    viewerKey,
  } = usePatchLoader({
    collapseMode: settings.collapseMode,
    collapsePatterns,
    getGitHubToken,
    githubTokenVersion: tokenVersion,
    markdownView: settings.markdownView,
    onLoadStart,
    path,
    syncLocationHash: false,
    tokenHydrated: hydrated,
    viewerRef,
  });
  const handleViewerRef = useCallback(
    (viewer: CodeViewHandle<CommentMetadata, undefined> | null) => {
      viewerRef.current = viewer;
      if (viewer != null) {
        onViewerReady();
      }
    },
    [onViewerReady]
  );
  // Files arrive collapsed when the reader's settings say so (collapsed
  // mode, a collapse pattern, a file marked viewed on the review page), so
  // each file header gets the review page's expand/collapse chevron.
  const toggleItemCollapsed = useStableCallback((itemId: string) => {
    const handle = viewerRef.current;
    const item = handle?.getItem(itemId);
    if (handle == null || item == null) {
      return;
    }
    item.collapsed = item.collapsed !== true;
    incrementItemVersion(item);
    handle.updateItem(item);
  });
  const renderHeaderPrefix = useStableCallback(
    (item: CodeViewItem<CommentMetadata>) =>
      item.type === 'diff' ? (
        <CollapseDiffButton
          collapsed={item.collapsed}
          disabled={
            item.fileDiff.splitLineCount === 0 &&
            item.fileDiff.unifiedLineCount === 0
          }
          onToggle={() => toggleItemCollapsed(item.id)}
        />
      ) : null
  );
  const options = useMemo(
    () => ({
      layout: CODE_VIEW_LAYOUT,
      diffStyle,
      diffIndicators: settings.diffIndicators,
      overflow: settings.overflow,
      loadDiffFiles,
      disableBackground: !settings.showBackgrounds,
      disableLineNumbers: !settings.lineNumbers,
      lineHoverHighlight: 'number' as const,
      stickyHeaders: true,
      unsafeCSS: CODE_VIEW_CUSTOM_CSS,
    }),
    [diffStyle, loadDiffFiles, settings]
  );

  if (loadState === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
        <p className="text-foreground max-w-prose text-center">
          {errorMessage ?? 'The diff didn’t load.'}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={retryLoad}>
          Try again
        </Button>
      </div>
    );
  }
  if (loadState === 'empty') {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
        This pull request has no file changes.
      </div>
    );
  }
  // CodeView reads initialItems once, when it mounts, so it mounts only
  // once there are items to hand it (later stream batches go through the
  // handle's addItems). Same gate as the review page's viewer.
  const viewerReady =
    loadState === 'ready' ||
    (loadState === 'streaming' && initialItems.length > 0);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {diffStats != null && (
        <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-3 border-b px-3 text-xs tabular-nums">
          <span>
            {diffStats.fileCount.toLocaleString()}{' '}
            {diffStats.fileCount === 1 ? 'file' : 'files'}
          </span>
          <span className={TONE_TEXT_CLASS.success}>
            +{diffStats.addedLines.toLocaleString()}
          </span>
          <span className={TONE_TEXT_CLASS.failure}>
            −{diffStats.deletedLines.toLocaleString()}
          </span>
        </div>
      )}
      {!viewerReady && (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
          Loading the diff…
        </div>
      )}
      {viewerReady && (
        <ThemedCodeView<CommentMetadata>
          key={viewerKey}
          ref={handleViewerRef}
          initialItems={initialItems}
          className="cv-scrollbar relative h-full min-h-0 w-full min-w-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain [contain:strict] [overflow-anchor:none] [&_diffs-container]:overflow-clip"
          options={options}
          renderHeaderPrefix={renderHeaderPrefix}
        />
      )}
    </div>
  );
}
