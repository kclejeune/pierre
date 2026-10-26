import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
} from '@pierre/diffs';

import type { CommentMetadata, DocPreviewMetadata } from './types';

export const DOC_PREVIEW_KEY = 'doc-preview';

export function isDocAnnotation(
  annotation: DiffLineAnnotation<CommentMetadata>
): annotation is DiffLineAnnotation<DocPreviewMetadata> {
  return annotation.metadata.kind === 'doc';
}

// The rendered document anchors to the deletions side only when the file was
// deleted — there is no additions side to render.
export function getDocAnnotationSide(
  fileDiff: FileDiffMetadata
): 'additions' | 'deletions' {
  return fileDiff.type === 'deleted' ? 'deletions' : 'additions';
}

// Whether an item carries the rendered-document annotation, i.e. its doc view
// is open and the source diff rows are hidden underneath it.
export function hasDocAnnotation(
  annotations: readonly DiffLineAnnotation<CommentMetadata>[] | undefined
): boolean {
  return annotations?.some(isDocAnnotation) === true;
}

// The diff of an item whose rendered markdown document is open (hiding its
// source rows), or null when line scrolls can target the rows directly.
export function getOpenDocDiff(
  item: CodeViewItem<CommentMetadata> | undefined
): FileDiffMetadata | null {
  return item?.type === 'diff' && hasDocAnnotation(item.annotations)
    ? item.fileDiff
    : null;
}
