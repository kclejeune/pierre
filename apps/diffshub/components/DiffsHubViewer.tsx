import {
  areSelectionsEqual,
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffIndicators,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
  isDiffAnnotation,
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
import { cn } from '@/lib/cn';
import { CODE_VIEW_CUSTOM_CSS, CODE_VIEW_LAYOUT } from '@/lib/constants';
import { incrementItemVersion } from '@/lib/incrementItemVersion';
import { isDiffItem } from '@/lib/isDiffItem';
import {
  DOC_PREVIEW_KEY,
  getDocAnnotationSide,
  isDocAnnotation,
} from '@/lib/isDocAnnotation';
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
import {
  createPullReviewThread,
  createThreadAnnotation,
} from '@/lib/pullReviewThreads';
import {
  createLocalSavedCommentEvent,
  createThreadSavedCommentEvent,
} from '@/lib/savedCommentEvent';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';
import type {
  CommentAuthor,
  CommentMetadata,
  DiffsHubDeletedCommentEvent,
  DiffsHubSavedCommentEvent,
  SavedCommentMetadata,
} from '@/lib/types';

const EMPTY_DOC_RAIL_COMMENTS: DiffLineAnnotation<CommentMetadata>[] = [];

// The single predicate for both halves of the doc-rail partition: comments it
// matches render in the rendered document's margin rail while the doc is
// open, and are suppressed at their diff lines. Keeping one predicate ensures
// no annotation is ever shown twice or silently dropped.
function isDocRailComment(
  annotation:
    | DiffLineAnnotation<CommentMetadata>
    | LineAnnotation<CommentMetadata>,
  item: CodeViewDiffItem<CommentMetadata>
): annotation is DiffLineAnnotation<CommentMetadata> {
  return (
    isDiffAnnotation<CommentMetadata>(annotation) &&
    annotation.metadata.kind !== 'doc' &&
    annotation.side === getDocAnnotationSide(item.fileDiff)
  );
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

  incrementItemVersion(item);
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
  // The diff-source path (e.g. owner/repo/pull/123) on the configured GitHub
  // instance; lets the rendered-document view proxy relative image
  // references. Unset for arbitrary-domain patch URLs.
  sourcePath?: string;
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
  sourcePath,
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
      const token = getWriteToken();
      if (pullRequest != null && token != null) {
        const anchor = createCommentAnchor(
          item.fileDiff.name,
          draftAnnotation.metadata.range
        );
        if (anchor != null) {
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
            const updatedItem = replaceAnnotation(
              viewer,
              itemId,
              key,
              createThreadAnnotation(thread)
            );
            if (updatedItem == null) {
              return;
            }
            finishDraft(itemId, key);
            onCommentSaved(
              createThreadSavedCommentEvent(
                updatedItem.fileDiff,
                itemId,
                thread
              )
            );
            return;
          }
          // GitHub accepted the comment but echoed no usable anchor; fall
          // through and keep a local card so the text isn't lost.
        }
      }

      const savedAnnotation: DiffLineAnnotation<SavedCommentMetadata> = {
        ...draftAnnotation,
        metadata: {
          kind: 'saved',
          key,
          author,
          message: trimmedMessage,
          range: draftAnnotation.metadata.range,
        },
      };
      const updatedItem = replaceAnnotation(
        viewer,
        itemId,
        key,
        savedAnnotation
      );
      if (updatedItem == null) {
        return;
      }

      finishDraft(itemId, key);
      onCommentSaved(
        createLocalSavedCommentEvent(
          updatedItem.fileDiff,
          itemId,
          savedAnnotation
        )
      );
    }
  );

  // The saved token normalized to undefined when absent — the single spelling
  // of "can this session write to the PR".
  const getWriteToken = (): string | undefined => {
    const token = getGitHubToken?.();
    return token == null || token === '' ? undefined : token;
  };

  // Locates a thread annotation for the reply/edit/delete handlers below and
  // asserts the preconditions they share (mounted viewer, saved token).
  const getThreadContext = (itemId: string, key: string) => {
    const { current: viewer } = viewerRef;
    const token = getWriteToken();
    if (viewer == null || pullRequest == null || token == null) {
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
        onCommentSaved(
          createThreadSavedCommentEvent(item.fileDiff, itemId, nextThread)
        );
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
        onCommentSaved(
          createThreadSavedCommentEvent(item.fileDiff, itemId, nextThread)
        );
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
      const nextAnnotation = {
        ...annotation,
        metadata: { ...annotation.metadata, message },
      };
      const updatedItem = replaceAnnotation(
        viewer,
        itemId,
        key,
        nextAnnotation
      );
      if (updatedItem == null) {
        return;
      }
      onCommentSaved(
        createLocalSavedCommentEvent(
          updatedItem.fileDiff,
          itemId,
          nextAnnotation
        )
      );
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
        // The doc renders above the diff via the file-level (line 0) slot.
        {
          side: getDocAnnotationSide(item.fileDiff),
          lineNumber: 0,
          metadata: { kind: 'doc', key: DOC_PREVIEW_KEY },
        },
        ...annotations,
      ];
      return true;
    });
  });

  // A comment affordance in the rendered document maps back to a source line;
  // the draft it opens renders in the document's margin rail, so no scrolling
  // is needed to reach it.
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
    incrementItemVersion(item);
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

  // The comment card for a single draft/thread/saved annotation, rendered
  // either at its diff line or in the rendered document's margin rail.
  // Identity-stable so it can be passed to the memoized doc component.
  const renderCommentCard = useStableCallback(
    (annotation: DiffLineAnnotation<CommentMetadata>, itemId: string) => {
      if (isDraftAnnotation(annotation)) {
        return (
          <DraftAnnotation
            annotation={annotation}
            itemId={itemId}
            onCancel={handleRemoveComment}
            onSave={handleSaveDraftComment}
          />
        );
      }

      if (isThreadAnnotation(annotation)) {
        return (
          <ThreadAnnotation
            annotation={annotation}
            itemId={itemId}
            canWrite={getWriteToken() != null}
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
          itemId={itemId}
          onDelete={handleRemoveComment}
          onEdit={handleEditLocalComment}
          onToggleSelection={handleToggleCommentSelection}
        />
      );
    }
  );

  // Returns the comments that belong in an item's doc margin rail, cached by
  // the annotations array's identity so the memoized doc component sees the
  // same array across unrelated re-renders. `canWrite` joins the cache key
  // because the rendered cards depend on it (reply/edit affordances).
  const docRailCommentsCacheRef = useRef(
    new WeakMap<
      DiffLineAnnotation<CommentMetadata>[],
      { canWrite: boolean; comments: DiffLineAnnotation<CommentMetadata>[] }
    >()
  );
  const getDocRailComments = (
    item: CodeViewDiffItem<CommentMetadata>,
    canWrite: boolean
  ): DiffLineAnnotation<CommentMetadata>[] => {
    const { annotations } = item;
    if (annotations == null) {
      return EMPTY_DOC_RAIL_COMMENTS;
    }
    const cache = docRailCommentsCacheRef.current;
    const cached = cache.get(annotations);
    if (cached != null && cached.canWrite === canWrite) {
      return cached.comments;
    }
    const comments = annotations.filter((candidate) =>
      isDocRailComment(candidate, item)
    );
    cache.set(annotations, { canWrite, comments });
    return comments;
  };

  const renderCommentAnnotation = useStableCallback(
    (
      annotation:
        | DiffLineAnnotation<CommentMetadata>
        | LineAnnotation<CommentMetadata>,
      item: CodeViewItem<CommentMetadata>
    ) => {
      if (
        !isDiffAnnotation<CommentMetadata>(annotation) ||
        item.type !== 'diff'
      ) {
        return null;
      }

      if (isDocAnnotation(annotation)) {
        return (
          <MarkdownDocAnnotation
            fileDiff={item.fileDiff}
            itemId={item.id}
            loadDiffFiles={loadDiffFiles}
            onCommentAtLine={handleCommentAtDocLine}
            sourcePath={sourcePath}
            commentAnnotations={getDocRailComments(
              item,
              getWriteToken() != null
            )}
            renderComment={renderCommentCard}
          />
        );
      }

      // While the rendered document is open, its rail's comments render there
      // instead of at their diff lines.
      if (
        isDocRailComment(annotation, item) &&
        item.annotations?.some(isDocAnnotation) === true
      ) {
        return null;
      }

      return renderCommentCard(annotation, item.id);
    }
  );

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
