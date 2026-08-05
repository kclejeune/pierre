import type { DiffLineAnnotation } from '@pierre/diffs';

import type { CommentMetadata, ThreadCommentMetadata } from './types';

export function isThreadAnnotation(
  annotation: DiffLineAnnotation<CommentMetadata>
): annotation is DiffLineAnnotation<ThreadCommentMetadata> {
  return annotation.metadata.kind === 'thread';
}
