import type { CodeViewDiffItem } from '@pierre/diffs';

import {
  DOC_PREVIEW_KEY,
  getDocAnnotationSide,
  isDocAnnotation,
} from './isDocAnnotation';
import { isMarkdownFileName } from './isMarkdownFileName';
import type { CommentMetadata } from './types';

// Adds or removes the rendered-document annotation on a markdown diff item,
// mutating `item.annotations` in place. Returns whether anything changed so
// callers know to bump the item version; non-markdown items never change.
// Shared by the per-file header toggle and the global markdown-view mode.
export function applyDocPreviewToItem(
  item: CodeViewDiffItem<CommentMetadata>,
  shown: boolean
): boolean {
  if (!isMarkdownFileName(item.fileDiff.name)) {
    return false;
  }
  const annotations = item.annotations ?? [];
  const hasDoc = annotations.some(isDocAnnotation);
  if (shown === hasDoc) {
    return false;
  }
  if (!shown) {
    item.annotations = annotations.filter(
      (annotation) => !isDocAnnotation(annotation)
    );
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
}
