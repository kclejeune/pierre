import type { FileDiffMetadata } from '@pierre/diffs';

import type { DiffLocation } from './diffSearch';
import { getDocAnnotationSide } from './isDocAnnotation';
import { toNewFileLine } from './markdownChangeMap';
import type { DocScrollTarget } from './scrollDocTargetIntoView';

// The DOM contract of a rendered markdown document (MarkdownDocAnnotation),
// read by doc-aware scrolling (scrollDocTargetIntoView) and search highlights
// (DiffSearchHighlighter):
//  - the diffs-container host carries DOC_OPEN_ATTR = the diff side the
//    document renders, while the document hides the source rows;
//  - the card carries data-diffshub-doc-item (the item id) and
//    data-diffshub-doc-state (loading / error / ready);
//  - each top-level block carries the source lines it claims as
//    data-diffshub-doc-claim-start / -end, and its first child is the block's
//    content column (a comment rail, when present, follows it);
//  - each rail comment card carries data-diffshub-doc-comment (the key).
export const DOC_OPEN_ATTR = 'data-diffshub-doc-open';
const CLAIM_START_ATTR = 'data-diffshub-doc-claim-start';
const CLAIM_END_ATTR = 'data-diffshub-doc-claim-end';
export const DOC_BLOCK_SELECTOR = `[${CLAIM_START_ATTR}]`;
export const READY_DOC_CARD_SELECTOR = '[data-diffshub-doc-state="ready"]';

// Fired (bubbling) on the diffs-container host once a rendered document has
// committed its blocks, so search highlights can repaint onto the new text.
export const DOC_RENDERED_EVENT = 'diffshub-doc-rendered';

export interface DocBlock {
  element: Element;
  start: number;
  end: number;
}

// Every block in a rendered document card with the source lines it claims.
export function readDocBlocks(card: Element): DocBlock[] {
  return Array.from(card.querySelectorAll(DOC_BLOCK_SELECTOR), (element) => ({
    element,
    start: Number(element.getAttribute(CLAIM_START_ATTR)),
    end: Number(element.getAttribute(CLAIM_END_ATTR)),
  }));
}

// The block a source line belongs to. Malformed HTML can nest later blocks
// inside an earlier one, so several wrappers may claim the line; the
// narrowest is the block the line is in.
export function findClaimingBlock(
  blocks: readonly DocBlock[],
  line: number
): DocBlock | null {
  let best: DocBlock | null = null;
  for (const block of blocks) {
    if (
      line >= block.start &&
      line <= block.end &&
      (best == null || block.end - block.start < best.end - best.start)
    ) {
      best = block;
    }
  }
  return best;
}

// Resolves where a diff location shows up in its item's rendered document: the
// block whose claimed source range covers the location's line. A location on
// the other side of the diff (a removed line while the post-change document
// renders) is mapped to the new-file position its content occupied. Reports
// 'pending' while the card or document is still mounting or loading, and
// 'unavailable' when the document failed to render or no block claims the
// line, in which case the caller should scroll to the source line instead.
export function docLineTarget(
  fileDiff: FileDiffMetadata,
  location: Pick<DiffLocation, 'itemId' | 'side' | 'lineNumber'>
): () => DocScrollTarget {
  const selector = `[data-diffshub-doc-item="${CSS.escape(location.itemId)}"]`;
  const line =
    location.side === getDocAnnotationSide(fileDiff)
      ? location.lineNumber
      : toNewFileLine(fileDiff, location.lineNumber);
  return () => {
    const card = document.querySelector(selector);
    const state = card?.getAttribute('data-diffshub-doc-state');
    if (card == null || state === 'loading') {
      return 'pending';
    }
    if (state === 'error') {
      return 'unavailable';
    }
    return (
      findClaimingBlock(readDocBlocks(card), line)?.element ?? 'unavailable'
    );
  };
}

// Resolves a comment's card in the rendered document's margin rail.
export function docCommentTarget(key: string): () => DocScrollTarget {
  const selector = `[data-diffshub-doc-comment="${CSS.escape(key)}"]`;
  return () => document.querySelector(selector) ?? 'pending';
}
