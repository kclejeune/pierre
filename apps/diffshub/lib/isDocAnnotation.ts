import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';

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
