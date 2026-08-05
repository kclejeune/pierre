'use client';

import type {
  DiffLineAnnotation,
  FileDiffContentsLoader,
  FileDiffMetadata,
} from '@pierre/diffs';
import { IconPlus } from '@pierre/icons';
import type { Element as HastElement, Root as HastRoot } from 'hast';
import { memo, type ReactNode, useEffect, useMemo, useState } from 'react';
import type { Components } from 'react-markdown';

import { MarkdownContent } from './MarkdownContent';
import { cn } from '@/lib/cn';
import {
  buildNewFileChangeMap,
  findCommentableNewLine,
  rangeHasChanges,
} from '@/lib/markdownChangeMap';
import {
  createDocAssetURL,
  resolveDocAssetPath,
} from '@/lib/markdownDocAssets';
import type { CommentMetadata } from '@/lib/types';

interface MarkdownDocAnnotationProps {
  fileDiff: FileDiffMetadata;
  itemId: string;
  loadDiffFiles?: FileDiffContentsLoader;
  onCommentAtLine(itemId: string, line: number): void;
  // The diff-source path (e.g. owner/repo/pull/123) on the configured GitHub
  // instance; enables serving the doc's relative image references through the
  // asset proxy. Unset for arbitrary-domain patch URLs.
  sourcePath?: string;
  // Comment annotations on this document's side of the diff, shown in a
  // margin rail beside the block containing each comment's line while the
  // rendered view is open. `renderComment` supplies the card for each one.
  commentAnnotations?: DiffLineAnnotation<CommentMetadata>[];
  renderComment?(annotation: DiffLineAnnotation<CommentMetadata>): ReactNode;
}

// The rendered-markdown document view, shown as a file-level annotation above
// a markdown diff. Renders the post-change document (or the removed document
// for deletions) with change markers on blocks the diff touches, and a
// per-block affordance that opens a draft comment on the matching source line
// in the diff below.
export const MarkdownDocAnnotation = memo(function MarkdownDocAnnotation({
  fileDiff,
  itemId,
  loadDiffFiles,
  onCommentAtLine,
  sourcePath,
  commentAnnotations,
  renderComment,
}: MarkdownDocAnnotationProps) {
  const contentsState = useMarkdownDocContents(fileDiff, loadDiffFiles);
  // Deleted files render the removed document; its lines no longer exist on
  // the additions side, so change markers and comment anchors are disabled.
  const isDeletedDoc = fileDiff.type === 'deleted';
  const changeMap = useMemo(
    () => (isDeletedDoc ? null : buildNewFileChangeMap(fileDiff)),
    [fileDiff, isDeletedDoc]
  );
  // The rail only reserves layout space when there is something to show.
  const hasRail =
    renderComment != null &&
    commentAnnotations != null &&
    commentAnnotations.length > 0;

  const rehypePlugins = useMemo(() => [rehypeWrapTopLevelBlocks], []);
  const components = useMemo<Components>(
    () => ({
      // Relative image references point at repository paths; route them
      // through the asset proxy so they load from the raw host at this
      // diff's ref instead of 404ing against the DiffsHub origin.
      img: ({ node: _node, src, alt, ...rest }) => {
        const assetPath =
          typeof src === 'string' && sourcePath != null
            ? resolveDocAssetPath(src, fileDiff.name)
            : null;
        return (
          <img
            {...rest}
            alt={alt ?? ''}
            loading="lazy"
            src={
              assetPath != null && sourcePath != null
                ? createDocAssetURL(
                    sourcePath,
                    assetPath,
                    isDeletedDoc ? 'old' : 'new'
                  )
                : src
            }
          />
        );
      },
      div: (props) => {
        const { node } = props;
        const sourceStart = parseSourceLine(node?.properties?.dataSourceStart);
        const sourceEnd = parseSourceLine(node?.properties?.dataSourceEnd);
        if (sourceStart == null || sourceEnd == null) {
          return <div {...props} />;
        }
        const changed =
          changeMap != null &&
          rangeHasChanges(changeMap, sourceStart, sourceEnd);
        const commentLine = isDeletedDoc
          ? null
          : findCommentableNewLine(fileDiff, sourceStart, sourceEnd);
        // The claim range extends the block's own lines over the blank lines
        // that follow it, so every comment line maps to exactly one block.
        const claimStart =
          parseSourceLine(node?.properties?.dataClaimStart) ?? sourceStart;
        const claimEnd =
          parseSourceLine(node?.properties?.dataClaimEnd) ?? sourceEnd;
        const blockComments = hasRail
          ? commentAnnotations
              .filter(
                (annotation) =>
                  annotation.lineNumber >= claimStart &&
                  annotation.lineNumber <= claimEnd
              )
              .sort((a, b) => a.lineNumber - b.lineNumber)
          : [];
        return (
          <div
            className={cn(
              'group/mdblock',
              // Side-by-side only when the card itself is wide enough for a
              // readable prose column; otherwise comments stack below their
              // block. Container query, since the card's width tracks the
              // viewer column rather than the viewport.
              hasRail
                ? '@3xl:grid @3xl:grid-cols-[minmax(0,1fr)_minmax(260px,320px)] @3xl:gap-4'
                : 'relative'
            )}
          >
            <div className={cn(hasRail && 'relative min-w-0')}>
              {changed && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 bottom-1 -left-3 w-[3px] rounded-full bg-[#07c480]"
                />
              )}
              {commentLine != null && (
                <button
                  type="button"
                  title="Comment on this section"
                  aria-label="Comment on this section"
                  className="absolute top-0.5 -right-1 z-1 hidden size-5 cursor-pointer items-center justify-center rounded-[4px] bg-[rgb(0,159,255)] text-white opacity-90 group-hover/mdblock:inline-flex dark:text-black"
                  onClick={() => onCommentAtLine(itemId, commentLine)}
                >
                  <IconPlus size={14} />
                </button>
              )}
              {props.children}
            </div>
            {blockComments.length > 0 && (
              <div className="flex min-w-0 flex-col self-start">
                {blockComments.map((annotation) => (
                  <div key={annotation.metadata.key}>
                    {renderComment?.(annotation)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      },
    }),
    [
      changeMap,
      commentAnnotations,
      fileDiff,
      hasRail,
      isDeletedDoc,
      itemId,
      onCommentAtLine,
      renderComment,
      sourcePath,
    ]
  );

  return (
    <div
      className={cn(
        '@container m-2 rounded-xl border border-[var(--diffshub-annotation-border,var(--color-border))] bg-[var(--diffshub-annotation-bg,var(--color-card))] font-sans text-[var(--diffshub-annotation-fg,var(--color-card-foreground))] shadow-[var(--diffshub-annotation-shadow,0_2px_4px_rgb(0_0_0_/_0.025),0_4px_8px_rgb(0_0_0_/_0.025))]',
        hasRail ? 'max-w-[1240px]' : 'max-w-[860px]'
      )}
    >
      <div className="text-muted-foreground flex items-center gap-2 border-b border-[var(--diffshub-annotation-border,var(--color-border))] px-4 py-2 text-[12px] tracking-wide uppercase">
        {isDeletedDoc ? 'Rendered document (removed)' : 'Rendered document'}
        {changeMap != null && (
          <span className="normal-case">
            — changed sections are marked in the margin
          </span>
        )}
      </div>
      <div className="px-6 py-4">
        {contentsState.kind === 'loading' && (
          <p className="text-muted-foreground m-0 text-[13px]">
            Loading document…
          </p>
        )}
        {contentsState.kind === 'error' && (
          <p className="text-muted-foreground m-0 text-[13px]">
            {contentsState.message}
          </p>
        )}
        {contentsState.kind === 'ready' && (
          <MarkdownContent
            markdown={contentsState.contents}
            rehypePlugins={rehypePlugins}
            components={components}
          />
        )}
        {contentsState.kind !== 'ready' &&
          hasRail && (
            // Without rendered blocks to attach to, keep the comments visible
            // as a flat list so they never silently disappear.
            <div className="mt-2 flex max-w-[620px] flex-col">
              {commentAnnotations.map((annotation) => (
                <div key={annotation.metadata.key}>
                  {renderComment(annotation)}
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
});

type MarkdownDocContentsState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; contents: string };

// Resolves the document text to render. New and deleted files (and hydrated
// diffs) already carry complete contents in the parsed metadata; partially
// loaded diffs fetch the full new file through the same loader that powers
// hunk expansion, which requires a saved token.
function useMarkdownDocContents(
  fileDiff: FileDiffMetadata,
  loadDiffFiles: FileDiffContentsLoader | undefined
): MarkdownDocContentsState {
  const localContents = useMemo(() => {
    // Parsed lines keep their trailing newlines, so concatenate rather than
    // join — a '\n' separator would double every line break, silently shifting
    // all source positions (and therefore comment anchors) in the rendered
    // document.
    if (fileDiff.type === 'deleted') {
      return fileDiff.deletionLines.join('');
    }
    if (fileDiff.type === 'new' || !fileDiff.isPartial) {
      return fileDiff.additionLines.join('');
    }
    return null;
  }, [fileDiff]);

  const [fetchedState, setFetchedState] =
    useState<MarkdownDocContentsState | null>(null);

  useEffect(() => {
    if (localContents != null) {
      return;
    }
    if (loadDiffFiles == null) {
      setFetchedState({
        kind: 'error',
        message:
          'Rendering this document needs the full file. Sign in with GitHub or save a token to load it.',
      });
      return;
    }

    let cancelled = false;
    setFetchedState({ kind: 'loading' });
    Promise.resolve(loadDiffFiles(fileDiff)).then(
      (files) => {
        if (cancelled) {
          return;
        }
        const contents = files.newFile?.contents;
        setFetchedState(
          contents != null
            ? { kind: 'ready', contents }
            : { kind: 'error', message: 'The file contents were unavailable.' }
        );
      },
      (error: unknown) => {
        if (!cancelled) {
          setFetchedState({
            kind: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Loading the file failed.',
          });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [fileDiff, loadDiffFiles, localContents]);

  if (localContents != null) {
    return { kind: 'ready', contents: localContents };
  }
  return fetchedState ?? { kind: 'loading' };
}

// The wrapper attributes round-trip through rehype-raw's HTML re-parse, which
// turns the numbers the plugin wrote into strings.
function parseSourceLine(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : null;
}

// Wraps every top-level block of the document in a div carrying its source
// line range, so the components override above can attach change markers and
// comment affordances without re-parsing the markdown.
//
// This must run BEFORE rehype-raw (MarkdownContent orders caller plugins
// first): raw re-parses the whole document, and malformed HTML — an unclosed
// <div> in a README, say — absorbs every later block into one element whose
// position spans the rest of the file. Comment anchors computed from such a
// range land on unrelated lines. Wrapping first captures each block's true
// range; the re-parse merely nests the wrappers inside the malformed element,
// which is why the div override above matches wrappers at any depth rather
// than only at the top level.
function rehypeWrapTopLevelBlocks() {
  return (tree: HastRoot) => {
    // Beyond its own source range, each block also claims the lines between
    // it and the next block (blank lines, mostly), and the first block claims
    // everything above it. That partitions every document line to exactly one
    // block, so a comment on any line has a home in the margin rail.
    const positioned = tree.children.filter(
      (child) => child.type === 'element' && child.position != null
    );
    const claimStarts = new Map<HastRoot['children'][number], number>();
    const claimEnds = new Map<HastRoot['children'][number], number>();
    for (const [index, child] of positioned.entries()) {
      if (child.type !== 'element' || child.position == null) {
        continue;
      }
      claimStarts.set(child, index === 0 ? 1 : child.position.start.line);
      const next = positioned[index + 1];
      claimEnds.set(
        child,
        next?.type === 'element' && next.position != null
          ? next.position.start.line - 1
          : Number.MAX_SAFE_INTEGER
      );
    }
    tree.children = tree.children.map((child) => {
      if (child.type !== 'element' || child.position == null) {
        return child;
      }
      const wrapper: HastElement = {
        type: 'element',
        tagName: 'div',
        properties: {
          dataSourceStart: child.position.start.line,
          dataSourceEnd: child.position.end.line,
          dataClaimStart: claimStarts.get(child) ?? child.position.start.line,
          dataClaimEnd: claimEnds.get(child) ?? child.position.end.line,
        },
        children: [child],
      };
      return wrapper;
    });
  };
}
