import type { DiffLineAnnotation } from '@pierre/diffs';

import type { CommentMetadata, DocPreviewMetadata } from './types';

export const DOC_PREVIEW_KEY = 'doc-preview';

export function isDocAnnotation(
  annotation: DiffLineAnnotation<CommentMetadata>
): annotation is DiffLineAnnotation<DocPreviewMetadata> {
  return annotation.metadata.kind === 'doc';
}
