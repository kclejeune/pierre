import {
  areSelectionsEqual,
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffIndicators,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
  type LineAnnotation,
  type SelectedLineRange,
  type ThemeTypes,
} from '@pierre/diffs';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import { IconBook, IconChevronSm } from '@pierre/icons';
import { memo, type RefObject, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { DraftAnnotation } from './DraftAnnotation';
import { ExampleAnnotation } from './ExampleAnnotation';
import { MarkdownDocAnnotation } from './MarkdownDocAnnotation';
import { ThemedCodeView } from './ThemedCodeView';
import { ThreadAnnotation } from './ThreadAnnotation';
import { useChromeThemeProps } from './useChromeThemeProps';
import { buildAnnotationThemeStyle } from '@/lib/annotationThemeStyle';
import { classifyCommentLineType } from '@/lib/classifyCommentLineType';
import { cn } from '@/lib/cn';
import { CODE_VIEW_CUSTOM_CSS, CODE_VIEW_LAYOUT } from '@/lib/constants';
import { isDiffItem } from '@/lib/isDiffItem';
import { DOC_PREVIEW_KEY, isDocAnnotation } from '@/lib/isDocAnnotation';
import { isDraftAnnotation } from '@/lib/isDraftAnnotation';
import { isDraftMetadata } from '@/lib/isDraftMetadata';
import { isMarkdownFileName } from '@/lib/isMarkdownFileName';
import { isSavedAnnotation } from '@/lib/isSavedAnnotation';
import { isThreadAnnotation } from '@/lib/isThreadAnnotation';
import {
  createCommentAnchor,
  deletePullReviewComment,
  editPullReviewComment,
  postPullReviewComment,
  postPullReviewReply,
  type PullRequestRef,
} from '@/lib/pullCommentsClient';
import { createPullReviewThread } from '@/lib/pullReviewThreads';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';
import type {
  CommentAuthor,
  CommentMetadata,
  DiffsHubDeletedCommentEvent,
  DiffsHubSavedCommentEvent,
} from '@/lib/types';

function getNextItemVersion(item: CodeViewItem<CommentMetadata>): number {
  return typeof item.version === 'number' ? item.version + 1 : 1;
}

function updateViewerDiffItem(
  viewer: CodeViewHandle<CommentMetadata>,
  itemId: string,
  updateItem: (item: CodeViewDiffItem<CommentMetadata>) => boolean
): CodeViewDiffItem<CommentMetadata> | undefined {
  const item = viewer.getItem(itemId);
  if (item == null || !isDiffItem(item)) {
    return undefined;
  }

  if (!updateItem(item)) {
    return undefined;
  }

  item.version = getNextItemVersion(item);
  return viewer.updateItem(item) ? item : undefined;
}

interface ActiveDraftComment {
  itemId: string;
  key: string;
}

interface DiffsHubViewerProps {
  className?: string;
  diffStyle: 'split' | 'unified';
  // Set when the viewer shows a pull request on the configured GitHub
  // instance; enables publishing comments/replies to the real PR.
  pullRequest?: PullRequestRef;
  getGitHubToken?(): string | undefined;
  onCommentDeleted(comment: DiffsHubDeletedCommentEvent): void;
  onCommentSaved(comment: DiffsHubSavedCommentEvent): void;
  overflow: 'wrap' | 'scroll';
  showBackgrounds: boolean;
  diffIndicators: DiffIndicators;
  lineNumbers: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  themeType: ThemeTypes;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
  initialItems: CodeViewItem<CommentMetadata>[];
  loadDiffFiles?: FileDiffContentsLoader;
  onLineLinkChange(selection: CodeViewLineSelection | null): void;
  onViewerReady(): void;
}

export const DiffsHubViewer = memo(function DiffsHubViewer({
  className,
  diffStyle,
  pullRequest,
  getGitHubToken,
  onCommentDeleted,
  onCommentSaved,
  overflow,
  showBackgrounds,
  diffIndicators,
  lineNumbers,
  scrollRef,
  themeType,
  viewerRef,
  initialItems,
  loadDiffFiles,
  onLineLinkChange,
  onViewerReady,
}: DiffsHubViewerProps) {
  const nextCommentKeyRef = useRef(0);
  const activeDraftRef = useRef<ActiveDraftComment | null>(null);
  const [selectedLines, setSelectedLines] =
    useState<CodeViewLineSelection | null>(null);
  const { style: chromeStyle } = useChromeThemeProps(diffshubChromeMapping);
  // Preserve the previous `undefined`-means-not-resolved contract that
  // buildAnnotationThemeStyle and the className fallbacks depend on.
  const themeChromeStyle =
    Object.keys(chromeStyle).length > 0 ? chromeStyle : undefined;
  const annotationThemeStyle = useMemo(
    () => buildAnnotationThemeStyle(themeChromeStyle),
    [themeChromeStyle]
  );

  const handleSetSelection = useStableCallback(
    (selection: CodeViewLineSelection | null) => {
      setSelectedLines(selection);
    }
  );

  const handleToggleCommentSelection = useStableCallback(
    (selection: CodeViewLineSelection) => {
      setSelectedLines((prev) =>
        prev?.id === selection.id &&
        areSelectionsEqual(prev.range, selection.range)
          ? null
          : selection
      );
    }
  );

  const handleLineSelectionEnd = useStableCallback(
    (range: SelectedLineRange | null, item: CodeViewItem<CommentMetadata>) => {
      if (range == null || item.type !== 'diff') {
        onLineLinkChange(null);
      } else {
        onLineLinkChange({ id: item.id, range });
      }
    }
  );

  const handleViewerRef = useStableCallback(
    (viewer: CodeViewHandle<CommentMetadata> | null) => {
      viewerRef.current = viewer;
      if (viewer != null) {
        onViewerReady();
      }
    }
  );

  const handleCreateDraftComment = useStableCallback(
    (range: SelectedLineRange, itemId: string) => {
      const side = range.endSide ?? range.side;
      if (side == null) {
        return;
      }

      const lineNumber = range.end;
      const commentKey = `draft-${nextCommentKeyRef.current++}`;
      const { current: viewer } = viewerRef;
      if (viewer == null) {
        return;
      }

      const draftAnnotation: DiffLineAnnotation<CommentMetadata> = {
        side,
        lineNumber,
        metadata: {
          kind: 'draft',
          key: commentKey,
          message: '',
          range,
        },
      };

      const { current: activeDraft } = activeDraftRef;
      if (activeDraft != null && activeDraft.itemId !== itemId) {
        updateViewerDiffItem(viewer, activeDraft.itemId, (item) => {
          if (item.annotations == null) {
            return false;
          }

          const nextAnnotations = item.annotations.filter(
            (annotation) => annotation.metadata.key !== activeDraft.key
          );
          if (nextAnnotations.length === item.annotations.length) {
            return false;
          }

          item.annotations = nextAnnotations;
          return true;
        });
      }

      const updatedItem = updateViewerDiffItem(viewer, itemId, (item) => {
        const nonDraftAnnotations = (item.annotations ?? []).filter(
          (annotation) => !isDraftMetadata(annotation.metadata)
        );
        item.annotations = [...nonDraftAnnotations, draftAnnotation];
        return true;
      });

      if (updatedItem != null) {
        activeDraftRef.current = { itemId, key: commentKey };
      }
    }
  );

  const handleRemoveComment = useStableCallback(
    (itemId: string, key: string) => {
      const { current: viewer } = viewerRef;
      if (viewer == null) {
        return;
      }
      const item = viewer.getItem(itemId);
      const removedAnnotation =
        item != null && isDiffItem(item)
          ? item.annotations?.find(
              (annotation) => annotation.metadata.key === key
            )
          : undefined;

      updateViewerDiffItem(viewer, itemId, (item) => {
        if (item.annotations == null) {
          return false;
        }

        const nextAnnotations = item.annotations.filter(
          (annotation) => annotation.metadata.key !== key
        );

        if (nextAnnotations.length === item.annotations.length) {
          return false;
        }

        item.annotations = nextAnnotations;
        return true;
      });

      const { current: activeDraft } = activeDraftRef;
      if (activeDraft?.itemId === itemId && activeDraft.key === key) {
        activeDraftRef.current = null;
      }

      setSelectedLines(null);
      onLineLinkChange(null);
      if (removedAnnotation != null && isSavedAnnotation(removedAnnotation)) {
        onCommentDeleted({ itemId, key });
      }
    }
  );

  // Swaps the annotation with the given key for `nextAnnotation` (or removes
  // it when null) and returns the updated item.
  const replaceAnnotation = (
    viewer: CodeViewHandle<CommentMetadata>,
    itemId: string,
    key: string,
    nextAnnotation: DiffLineAnnotation<CommentMetadata> | null
  ) =>
    updateViewerDiffItem(viewer, itemId, (item) => {
      if (item.annotations == null) {
        return false;
      }
      const nextAnnotations =
        nextAnnotation == null
          ? item.annotations.filter(
              (annotation) => annotation.metadata.key !== key
            )
          : item.annotations.map((annotation) =>
              annotation.metadata.key === key ? nextAnnotation : annotation
            );
      const didChange =
        nextAnnotations.length !== item.annotations.length ||
        nextAnnotations.some(
          (annotation, index) => annotation !== item.annotations?.[index]
        );
      if (!didChange) {
        return false;
      }
      item.annotations = nextAnnotations;
      return true;
    });

  const finishDraft = (itemId: string, key: string) => {
    const { current: activeDraft } = activeDraftRef;
    if (activeDraft?.itemId === itemId && activeDraft.key === key) {
      activeDraftRef.current = null;
    }
    setSelectedLines(null);
    onLineLinkChange(null);
  };

  const handleSaveDraftComment = useStableCallback(
    async (
      itemId: string,
      key: string,
      message: string,
      author: CommentAuthor
    ) => {
      const trimmedMessage = message.trim();
      const { current: viewer } = viewerRef;
      if (trimmedMessage.length === 0 || viewer == null) {
        return;
      }

      const item = viewer.getItem(itemId);
      if (item == null || !isDiffItem(item)) {
        return;
      }

      const draftAnnotation = item?.annotations?.find(
        (annotation) => annotation.metadata.key === key
      );
      if (draftAnnotation == null || !isDraftAnnotation(draftAnnotation)) {
        return;
      }

      // On a pull-request view with a token, comments publish to the real PR
      // and become GitHub-backed threads; otherwise they stay local.
      const token = getGitHubToken?.();
      const anchor =
        pullRequest != null && token != null && token !== ''
          ? createCommentAnchor(
              item.fileDiff.name,
              draftAnnotation.metadata.range
            )
          : null;
      if (
        pullRequest != null &&
        token != null &&
        token !== '' &&
        anchor != null
      ) {
        let comment;
        try {
          comment = await postPullReviewComment(
            pullRequest,
            token,
            anchor,
            trimmedMessage
          );
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Posting the comment failed.'
          );
          throw error;
        }
        const thread = createPullReviewThread(comment);
        if (thread != null) {
          const updatedItem = replaceAnnotation(viewer, itemId, key, {
            side: thread.side,
            lineNumber: thread.lineNumber,
            metadata: {
              kind: 'thread',
              key: thread.key,
              range: thread.range,
              thread,
            },
          });
          if (updatedItem == null) {
            return;
          }
          finishDraft(itemId, key);
          onCommentSaved({
            author: comment.author,
            itemId,
            key: thread.key,
            lineNumber: thread.lineNumber,
            lineType: classifyCommentLineType(
              updatedItem.fileDiff,
              thread.side,
              thread.lineNumber
            ),
            message: comment.body,
            range: thread.range,
            side: thread.side,
          });
          return;
        }
        // GitHub accepted the comment but echoed no usable anchor; fall
        // through and keep a local card so the text isn't lost.
      }

      const updatedItem = replaceAnnotation(viewer, itemId, key, {
        ...draftAnnotation,
        metadata: {
          kind: 'saved',
          key,
          author,
          message: trimmedMessage,
          range: draftAnnotation.metadata.range,
        },
      });
      if (updatedItem == null) {
        return;
      }

      finishDraft(itemId, key);
      onCommentSaved({
        author,
        itemId,
        key,
        lineNumber: draftAnnotation.lineNumber,
        lineType: classifyCommentLineType(
          updatedItem.fileDiff,
          draftAnnotation.side,
          draftAnnotation.lineNumber
        ),
        message: trimmedMessage,
        range: draftAnnotation.metadata.range,
        side: draftAnnotation.side,
      });
    }
  );

  // Locates a thread annotation for the reply/edit/delete handlers below and
  // asserts the preconditions they share (mounted viewer, saved token).
  const getThreadContext = (itemId: string, key: string) => {
    const { current: viewer } = viewerRef;
    const token = getGitHubToken?.();
    if (
      viewer == null ||
      pullRequest == null ||
      token == null ||
      token === ''
    ) {
      return null;
    }
    const item = viewer.getItem(itemId);
    if (item == null || !isDiffItem(item)) {
      return null;
    }
    const annotation = item.annotations?.find(
      (candidate) => candidate.metadata.key === key
    );
    if (annotation == null || !isThreadAnnotation(annotation)) {
      return null;
    }
    return { annotation, item, pullRequest, token, viewer };
  };

  const handleThreadReply = useStableCallback(
    async (itemId: string, key: string, body: string) => {
      const context = getThreadContext(itemId, key);
      if (context == null) {
        return;
      }
      const { annotation, token, viewer } = context;
      const { thread } = annotation.metadata;
      let comment;
      try {
        comment = await postPullReviewReply(
          context.pullRequest,
          token,
          thread.rootId,
          body
        );
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Posting the reply failed.'
        );
        throw error;
      }
      replaceAnnotation(viewer, itemId, key, {
        ...annotation,
        metadata: {
          ...annotation.metadata,
          thread: { ...thread, comments: [...thread.comments, comment] },
        },
      });
    }
  );

  const handleThreadEditComment = useStableCallback(
    async (itemId: string, key: string, commentId: number, body: string) => {
      const context = getThreadContext(itemId, key);
      if (context == null) {
        return;
      }
      const { annotation, item, token, viewer } = context;
      const { thread } = annotation.metadata;
      let edited;
      try {
        edited = await editPullReviewComment(
          context.pullRequest,
          token,
          commentId,
          body
        );
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Editing the comment failed.'
        );
        throw error;
      }
      const nextThread = {
        ...thread,
        comments: thread.comments.map((comment) =>
          comment.id === commentId ? { ...comment, body: edited.body } : comment
        ),
      };
      replaceAnnotation(viewer, itemId, key, {
        ...annotation,
        metadata: { ...annotation.metadata, thread: nextThread },
      });
      // The sidebar shows the thread's first comment; keep it in sync.
      if (thread.comments[0]?.id === commentId) {
        onCommentSaved({
          author: nextThread.comments[0].author,
          itemId,
          key,
          lineNumber: thread.lineNumber,
          lineType: classifyCommentLineType(
            item.fileDiff,
            thread.side,
            thread.lineNumber
          ),
          message: edited.body,
          range: thread.range,
          side: thread.side,
        });
      }
    }
  );

  const handleThreadDeleteComment = useStableCallback(
    async (itemId: string, key: string, commentId: number) => {
      const context = getThreadContext(itemId, key);
      if (context == null) {
        return;
      }
      const { annotation, item, token, viewer } = context;
      const { thread } = annotation.metadata;
      try {
        await deletePullReviewComment(context.pullRequest, token, commentId);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Deleting the comment failed.'
        );
        throw error;
      }
      const remaining = thread.comments.filter(
        (comment) => comment.id !== commentId
      );
      if (remaining.length === 0) {
        replaceAnnotation(viewer, itemId, key, null);
        onCommentDeleted({ itemId, key });
        return;
      }
      const nextThread = { ...thread, comments: remaining };
      replaceAnnotation(viewer, itemId, key, {
        ...annotation,
        metadata: { ...annotation.metadata, thread: nextThread },
      });
      if (thread.comments[0]?.id === commentId) {
        onCommentSaved({
          author: remaining[0].author,
          itemId,
          key,
          lineNumber: thread.lineNumber,
          lineType: classifyCommentLineType(
            item.fileDiff,
            thread.side,
            thread.lineNumber
          ),
          message: remaining[0].body,
          range: thread.range,
          side: thread.side,
        });
      }
    }
  );

  const handleEditLocalComment = useStableCallback(
    (itemId: string, key: string, message: string) => {
      const { current: viewer } = viewerRef;
      if (viewer == null) {
        return;
      }
      const item = viewer.getItem(itemId);
      if (item == null || !isDiffItem(item)) {
        return;
      }
      const annotation = item.annotations?.find(
        (candidate) => candidate.metadata.key === key
      );
      if (annotation == null || !isSavedAnnotation(annotation)) {
        return;
      }
      const updatedItem = replaceAnnotation(viewer, itemId, key, {
        ...annotation,
        metadata: { ...annotation.metadata, message },
      });
      if (updatedItem == null) {
        return;
      }
      onCommentSaved({
        author: annotation.metadata.author,
        itemId,
        key,
        lineNumber: annotation.lineNumber,
        lineType: classifyCommentLineType(
          updatedItem.fileDiff,
          annotation.side,
          annotation.lineNumber
        ),
        message,
        range: annotation.metadata.range,
        side: annotation.side,
      });
    }
  );

  // Adds/removes the rendered-document annotation on a markdown diff item.
  const handleToggleDocPreview = useStableCallback((itemId: string) => {
    const { current: viewer } = viewerRef;
    if (viewer == null) {
      return;
    }
    updateViewerDiffItem(viewer, itemId, (item) => {
      const annotations = item.annotations ?? [];
      const withoutDoc = annotations.filter(
        (annotation) => !isDocAnnotation(annotation)
      );
      if (withoutDoc.length !== annotations.length) {
        item.annotations = withoutDoc;
        return true;
      }
      item.annotations = [
        // The doc renders above the diff via the file-level (line 0) slot;
        // deleted files anchor it to the deletions side they render from.
        {
          side: item.fileDiff.type === 'deleted' ? 'deletions' : 'additions',
          lineNumber: 0,
          metadata: { kind: 'doc', key: DOC_PREVIEW_KEY },
        },
        ...annotations,
      ];
      return true;
    });
  });

  // A comment affordance in the rendered document maps back to a source line;
  // open a draft there and bring the line into view.
  const handleCommentAtDocLine = useStableCallback(
    (itemId: string, lineNumber: number) => {
      handleCreateDraftComment(
        {
          start: lineNumber,
          side: 'additions',
          end: lineNumber,
          endSide: 'additions',
        },
        itemId
      );
      viewerRef.current?.scrollTo({
        type: 'line',
        id: itemId,
        lineNumber,
        side: 'additions',
        align: 'center',
        behavior: 'smooth-auto',
      });
    }
  );

  const handleToggleItemCollapsed = useStableCallback((itemId: string) => {
    const { current: viewerHandle } = viewerRef;
    const viewer = viewerHandle?.getInstance();
    const item = viewerHandle?.getItem(itemId);
    if (viewerHandle == null || viewer == null || item == null) {
      return;
    }

    // NOTE(amadeus): If the top of the item is before the scrollTop, then
    // we'll want to apply a scroll fix on the next render to ensure we
    // keep the collapsed file in view and anchored.
    const itemTop = viewer.getTopForItem(itemId);
    item.collapsed = item.collapsed !== true;
    item.version = getNextItemVersion(item);
    if (!viewerHandle.updateItem(item)) {
      return;
    }

    if (itemTop != null && itemTop < viewer.getScrollTop()) {
      viewer.scrollTo({
        type: 'item',
        id: item.id,
        align: 'start',
      });
    }
  });

  const renderCommentAnnotation = useStableCallback(
    (
      annotation:
        | DiffLineAnnotation<CommentMetadata>
        | LineAnnotation<CommentMetadata>,
      item: CodeViewItem<CommentMetadata>
    ) => {
      if (!('side' in annotation) || item.type !== 'diff') {
        return null;
      }

      if (isDocAnnotation(annotation)) {
        return (
          <MarkdownDocAnnotation
            fileDiff={item.fileDiff}
            itemId={item.id}
            loadDiffFiles={loadDiffFiles}
            onCommentAtLine={handleCommentAtDocLine}
          />
        );
      }

      if (isDraftAnnotation(annotation)) {
        return (
          <DraftAnnotation
            annotation={annotation}
            itemId={item.id}
            onCancel={handleRemoveComment}
            onSave={handleSaveDraftComment}
          />
        );
      }

      if (isThreadAnnotation(annotation)) {
        return (
          <ThreadAnnotation
            annotation={annotation}
            itemId={item.id}
            canWrite={pullRequest != null && hasWriteToken()}
            onDeleteComment={handleThreadDeleteComment}
            onEditComment={handleThreadEditComment}
            onReply={handleThreadReply}
          />
        );
      }

      if (!isSavedAnnotation(annotation)) {
        return null;
      }

      return (
        <ExampleAnnotation
          annotation={annotation}
          itemId={item.id}
          onDelete={handleRemoveComment}
          onEdit={handleEditLocalComment}
          onToggleSelection={handleToggleCommentSelection}
        />
      );
    }
  );

  function hasWriteToken(): boolean {
    const token = getGitHubToken?.();
    return token != null && token !== '';
  }

  const renderHeaderPrefix = useStableCallback(
    (item: CodeViewItem<CommentMetadata>) => {
      if (item.type !== 'diff') {
        return null;
      }

      return (
        <CollapseDiffButton
          disabled={
            item.fileDiff.splitLineCount === 0 &&
            item.fileDiff.unifiedLineCount === 0
          }
          collapsed={item.collapsed}
          onToggle={() => handleToggleItemCollapsed(item.id)}
        />
      );
    }
  );

  const renderHeaderMetadata = useStableCallback(
    (item: CodeViewItem<CommentMetadata>) => {
      if (item.type !== 'diff' || !isMarkdownFileName(item.fileDiff.name)) {
        return null;
      }

      const docShown = item.annotations?.some(isDocAnnotation) === true;
      return (
        <button
          type="button"
          aria-pressed={docShown}
          title={docShown ? 'Hide rendered document' : 'Show rendered document'}
          className={cn(
            'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition',
            docShown && 'text-foreground bg-muted'
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleToggleDocPreview(item.id);
          }}
        >
          <IconBook aria-hidden="true" className="size-4" />
        </button>
      );
    }
  );

  // NOTE(amadeus): For some insane reason, the react compiler did not know how
  // to properly memoize this, so we pulled it into a `useMemo` for safety...
  const options: CodeViewOptions<CommentMetadata> = useMemo(
    () =>
      ({
        // Use this to validate itemMetrics when changing layout with unsafeCSS.
        // __devOnlyValidateItemHeights: true,
        layout: CODE_VIEW_LAYOUT,
        themeType,
        diffStyle,
        diffIndicators,
        overflow,
        loadDiffFiles,
        disableBackground: !showBackgrounds,
        disableLineNumbers: !lineNumbers,
        lineHoverHighlight: 'number',
        // hunkSeparators: 'line-info-basic',
        enableLineSelection: true,
        enableGutterUtility: true,
        stickyHeaders: true,
        unsafeCSS: CODE_VIEW_CUSTOM_CSS,
        // FIXME(amadeus): Move all `onX` methods onto the react component maybe?
        onGutterUtilityClick(range, context) {
          if (context.item.type !== 'diff') {
            return;
          }
          handleCreateDraftComment(range, context.item.id);
        },
        onLineSelectionEnd(range, context) {
          handleLineSelectionEnd(range, context.item);
        },
      }) satisfies CodeViewOptions<CommentMetadata>,
    [
      diffIndicators,
      diffStyle,
      handleCreateDraftComment,
      handleLineSelectionEnd,
      lineNumbers,
      loadDiffFiles,
      overflow,
      showBackgrounds,
      themeType,
    ]
  );
  return (
    <ThemedCodeView<CommentMetadata>
      ref={handleViewerRef}
      containerRef={scrollRef}
      initialItems={initialItems}
      className={cn(
        className,
        'cv-scrollbar relative h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain border-b border-border w-full [contain:strict] [overflow-anchor:none] [will-change:scroll-position] md:border-b-0 [&_diffs-container]:overflow-clip [&_diffs-container]:[contain:layout_paint_style] [&_diffs-container]:shadow-[0_-1px_0_var(--diffshub-diff-separator,var(--color-border-opaque)),0_1px_0_var(--diffshub-diff-separator,var(--color-border-opaque))]'
      )}
      options={options}
      style={annotationThemeStyle}
      selectedLines={selectedLines}
      onSelectedLinesChange={handleSetSelection}
      renderAnnotation={renderCommentAnnotation}
      renderHeaderPrefix={renderHeaderPrefix}
      renderHeaderMetadata={renderHeaderMetadata}
    />
  );
});

interface CollapseDiffButtonProps {
  disabled?: boolean;
  collapsed?: boolean;
  onToggle(): void;
}

function CollapseDiffButton({
  disabled = false,
  collapsed = false,
  onToggle,
}: CollapseDiffButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={!disabled && !collapsed}
      aria-hidden={disabled}
      aria-label={
        disabled ? undefined : collapsed ? 'Expand diff' : 'Collapse diff'
      }
      className="text-muted-foreground hover:bg-muted hover:text-foreground ml-[-8px] inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition disabled:pointer-events-none disabled:opacity-50"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <IconChevronSm
        aria-hidden="true"
        className={cn(
          'size-4 transition-transform',
          (disabled || collapsed) && '-rotate-90'
        )}
      />
    </button>
  );
}
