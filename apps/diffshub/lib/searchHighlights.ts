import { SEARCH_HIGHLIGHT_CSS } from './constants';
import type {
  DiffLocation,
  DiffSearchMatch,
  DiffSearchSide,
} from './diffSearch';
import {
  DOC_BLOCK_SELECTOR,
  DOC_OPEN_ATTR,
  findClaimingBlock,
  readDocBlocks,
  READY_DOC_CARD_SELECTOR,
} from './renderedDocDom';

// Paints find-in-diff matches with the CSS Custom Highlight API. The viewer
// renders each file inside its own shadow root and only mounts the rows near
// the viewport, so highlights cannot be baked into the markup; instead every
// refresh walks the currently mounted rows, builds DOM Ranges over the
// matched characters, and hands them to `CSS.highlights`. The registry is
// document-wide, while the `::highlight()` rules that color the ranges live in
// the viewer's shadow stylesheet (CODE_VIEW_CUSTOM_CSS).
//
// Each highlighter owns one layer (`diffshub-<layer>-match` plus
// `diffshub-<layer>-active`), so the find bar, the search panel, and the
// symbol flash paint independently instead of overwriting each other.
//
// While a markdown file's rendered document is open its source rows are
// hidden, so matches on the document's side are also painted onto the
// rendered text (see paintDocMatches).

// A highlighted location. Search results also carry the matched line's text,
// which locating a match inside a rendered document needs.
export type HighlightLocation = DiffLocation &
  Partial<Pick<DiffSearchMatch, 'lineText'>>;

// The slice of the CodeView instance the highlighter reads: the items that
// currently have a mounted <diffs-container>.
interface RenderedItemsSource {
  getRenderedItems(): ReadonlyArray<{ id: string; element: HTMLElement }>;
}

function supportsSearchHighlights(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof Highlight !== 'undefined'
  );
}

export class DiffSearchHighlighter {
  // Matches indexed by item, then by `side:line`, so a refresh only touches
  // the rows that are mounted.
  private rowsByItem = new Map<string, Map<string, HighlightLocation[]>>();
  // Matches that carry their line text, per item and in source order: the
  // candidates for painting onto a rendered document (see paintDocMatches).
  private docMatchesByItem = new Map<string, HighlightLocation[]>();
  private active: HighlightLocation | null = null;
  private frame: number | undefined;
  private painted = false;
  private readonly matchName: string;
  private readonly activeName: string;

  constructor(
    layer: string,
    private getInstance: () => RenderedItemsSource | undefined
  ) {
    this.matchName = `diffshub-${layer}-match`;
    this.activeName = `diffshub-${layer}-active`;
    if (supportsSearchHighlights()) {
      adoptDocumentHighlightStyles();
    }
  }

  setMatches(
    matches: readonly HighlightLocation[],
    active: HighlightLocation | null
  ): void {
    this.rowsByItem = new Map();
    this.docMatchesByItem = new Map();
    for (const match of matches) {
      if (match.lineText != null) {
        const docMatches = this.docMatchesByItem.get(match.itemId);
        if (docMatches == null) {
          this.docMatchesByItem.set(match.itemId, [match]);
        } else {
          docMatches.push(match);
        }
      }
      let rows = this.rowsByItem.get(match.itemId);
      if (rows == null) {
        rows = new Map();
        this.rowsByItem.set(match.itemId, rows);
      }
      const key = getRowKey(match.side, match.lineNumber);
      const row = rows.get(key);
      if (row == null) {
        rows.set(key, [match]);
      } else {
        row.push(match);
      }
    }
    for (const docMatches of this.docMatchesByItem.values()) {
      docMatches.sort((a, b) =>
        a.lineNumber !== b.lineNumber
          ? a.lineNumber - b.lineNumber
          : a.start - b.start
      );
    }
    this.active = active;
    this.schedule();
  }

  clear(): void {
    this.setMatches([], null);
  }

  // Coalesces refresh requests (item renders, new results) into one DOM pass
  // per frame. Nothing to paint and nothing painted means nothing to do.
  schedule(): void {
    if (
      this.frame != null ||
      !supportsSearchHighlights() ||
      (this.rowsByItem.size === 0 && !this.painted)
    ) {
      return;
    }
    this.frame = window.requestAnimationFrame(() => {
      this.frame = undefined;
      this.refresh();
    });
  }

  dispose(): void {
    if (this.frame != null) {
      window.cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
    if (supportsSearchHighlights()) {
      CSS.highlights.delete(this.matchName);
      CSS.highlights.delete(this.activeName);
    }
  }

  private refresh(): void {
    const matchHighlight = new Highlight();
    const activeHighlight = new Highlight();
    const add = (match: HighlightLocation, range: Range) =>
      (match === this.active ? activeHighlight : matchHighlight).add(range);
    const instance = this.getInstance();
    if (instance != null && this.rowsByItem.size > 0) {
      for (const rendered of instance.getRenderedItems()) {
        const rows = this.rowsByItem.get(rendered.id);
        const root = rendered.element.shadowRoot;
        if (rows == null || root == null) {
          continue;
        }
        forEachMountedRow(root, (row, side, lineNumber) => {
          const matches = rows.get(getRowKey(side, lineNumber));
          if (matches == null) {
            return;
          }
          const nodes = collectTextNodes(row);
          for (const match of matches) {
            const range = createTextRange(nodes, match.start, match.end);
            if (range != null) {
              add(match, range);
            }
          }
        });
        const docMatches = this.docMatchesByItem.get(rendered.id);
        if (docMatches != null) {
          paintDocMatches(rendered.element, docMatches, add);
        }
      }
    }
    CSS.highlights.set(this.matchName, matchHighlight);
    CSS.highlights.set(this.activeName, activeHighlight);
    this.painted = matchHighlight.size > 0 || activeHighlight.size > 0;
  }
}

function getRowKey(side: DiffSearchSide, lineNumber: number): string {
  return `${side}:${lineNumber}`;
}

// Visits every mounted content row with the side and line number it shows.
// Split view keeps one code column per side; unified view interleaves both
// sides in one column, where a deleted line and an added/context line can
// share a number, so the row's line type picks the side. Plain file items
// have no diff columns and count as the new version.
function forEachMountedRow(
  root: ShadowRoot,
  visit: (row: Element, side: DiffSearchSide, lineNumber: number) => void
): void {
  const columns = root.querySelectorAll('code[data-code]');
  const containers = columns.length > 0 ? columns : [root];
  for (const column of containers) {
    const columnSide: DiffSearchSide | null =
      column instanceof Element && column.hasAttribute('data-deletions')
        ? 'deletions'
        : column instanceof Element && column.hasAttribute('data-additions')
          ? 'additions'
          : null;
    for (const row of column.querySelectorAll('[data-line]')) {
      const lineNumber = Number(row.getAttribute('data-line'));
      const side =
        columnSide ??
        (row.getAttribute('data-line-type') === 'change-deletion'
          ? 'deletions'
          : 'additions');
      visit(row, side, lineNumber);
    }
  }
}

// Text nodes under `root` in document order, optionally skipping those that
// `skip` rejects.
function collectTextNodes(root: Node, skip?: (node: Text) => boolean): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()) != null) {
    if (node instanceof Text && skip?.(node) !== true) {
      nodes.push(node);
    }
  }
  return nodes;
}

// Maps a character range of the concatenated text of `nodes` onto a DOM
// Range. Rows are a flat run of text nodes (one or more per syntax token) and
// rendered blocks a run of inline nodes, so walking them in order and counting
// characters lands on the right node and offset.
function createTextRange(
  nodes: readonly Text[],
  start: number,
  end: number
): Range | null {
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const length = node.data.length;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

// Paints matches onto an item's rendered markdown document while it is open
// (see renderedDocDom for the attributes MarkdownDocAnnotation stamps). Each
// match on the document's side is assigned to the narrowest block claiming its
// line, then found in that block's rendered text as the same occurrence of
// its matched characters it is on its source line. `matches` arrives in
// source order, so later lines search past earlier ones. Rendering drops markdown syntax, so a match that spans syntax
// (`**bo` in `**bold**`) or sits in hidden source (a link URL) has no rendered
// counterpart and is skipped; matches on removed lines are not in the
// post-change document at all.
function paintDocMatches(
  host: HTMLElement,
  matches: readonly HighlightLocation[],
  add: (match: HighlightLocation, range: Range) => void
): void {
  const side = host.getAttribute(DOC_OPEN_ATTR);
  if (side == null) {
    return;
  }
  const card = host.querySelector(READY_DOC_CARD_SELECTOR);
  if (card == null) {
    return;
  }
  const blocks = readDocBlocks(card);
  const matchesByBlock = new Map<Element, HighlightLocation[]>();
  for (const match of matches) {
    if (match.side !== side) {
      continue;
    }
    const block = findClaimingBlock(blocks, match.lineNumber)?.element;
    if (block != null) {
      const list = matchesByBlock.get(block);
      if (list == null) {
        matchesByBlock.set(block, [match]);
      } else {
        list.push(match);
      }
    }
  }
  for (const [block, blockMatches] of matchesByBlock) {
    // The block's first child is its content column; a comment rail, when
    // present, follows it. Text of blocks nested inside this one (malformed
    // HTML) belongs to those blocks.
    const content = block.firstElementChild ?? block;
    const nodes = collectTextNodes(
      content,
      (node) => node.parentElement?.closest(DOC_BLOCK_SELECTOR) !== block
    );
    const text = nodes.map((node) => node.data).join('');
    // `searchFrom` tracks where the next source line can start in the
    // rendered text.
    let searchFrom = 0;
    let index = 0;
    while (index < blockMatches.length) {
      const { lineNumber, lineText = '' } = blockMatches[index];
      const anchor = anchorSourceLine(text, lineText, searchFrom);
      const lineStart = anchor?.at ?? searchFrom;
      const lineSource = anchor?.text ?? lineText;
      const toLine = anchor?.toText ?? ((offset: number) => offset);
      let cursor = lineStart;
      let last: { needle: string; end: number } | null = null;
      for (
        ;
        index < blockMatches.length &&
        blockMatches[index].lineNumber === lineNumber;
        index++
      ) {
        const match = blockMatches[index];
        const needle = lineText.slice(match.start, match.end);
        if (needle === '') {
          continue;
        }
        // The match is the n-th occurrence of its text on its source line
        // (`cat` in `scatter cat` is the second), so pick the n-th rendered
        // occurrence rather than the first one past the cursor.
        const found = findOccurrence(
          text,
          needle,
          lineStart,
          countOccurrences(lineSource, needle, 0, toLine(match.start))
        );
        if (found === -1) {
          continue;
        }
        const range = createTextRange(nodes, found, found + needle.length);
        if (range != null) {
          add(match, range);
        }
        cursor = found + needle.length;
        last = { needle, end: match.end };
      }
      if (anchor != null) {
        searchFrom = anchor.at + anchor.text.length;
      } else if (last != null) {
        // Unanchored: step past the rest of the line's occurrences of its last
        // matched text so the next line does not land on them.
        const rest = countOccurrences(
          lineText,
          last.needle,
          last.end,
          lineText.length
        );
        const skipped =
          rest === 0 ? -1 : findOccurrence(text, last.needle, cursor, rest - 1);
        searchFrom = skipped === -1 ? cursor : skipped + last.needle.length;
      } else {
        searchFrom = cursor;
      }
    }
  }
}

// Leading list, quote, and heading markers, plus inline code, emphasis, and
// strikethrough markers: syntax rendering drops. Underscores stay, since
// they are usually part of a word (snake_case) rather than emphasis.
const INLINE_SYNTAX = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*|#{1,6}\s+)|[`*~]/g;

// Locates a source line inside a block's rendered text. Code blocks and plain
// lines render verbatim; otherwise the line is retried with the syntax in
// INLINE_SYNTAX removed. Returns where the line starts, the form of the line
// that matched, and a mapping from source-line offsets into that form, or
// null when neither form appears (links and other syntax that rewrites text).
function anchorSourceLine(
  text: string,
  lineText: string,
  from: number
): { at: number; text: string; toText(offset: number): number } | null {
  if (lineText.trim() === '') {
    return null;
  }
  const verbatimAt = text.indexOf(lineText, from);
  if (verbatimAt !== -1) {
    return { at: verbatimAt, text: lineText, toText: (offset) => offset };
  }
  let stripped = '';
  const offsets: number[] = [];
  let kept = 0;
  for (const syntax of lineText.matchAll(INLINE_SYNTAX)) {
    for (; kept < syntax.index; kept++) {
      offsets[kept] = stripped.length;
      stripped += lineText[kept];
    }
    for (; kept < syntax.index + syntax[0].length; kept++) {
      offsets[kept] = stripped.length;
    }
  }
  for (; kept < lineText.length; kept++) {
    offsets[kept] = stripped.length;
    stripped += lineText[kept];
  }
  offsets[lineText.length] = stripped.length;
  const strippedAt =
    stripped.trim() === '' || stripped === lineText
      ? -1
      : text.indexOf(stripped, from);
  return strippedAt === -1
    ? null
    : { at: strippedAt, text: stripped, toText: (offset) => offsets[offset] };
}

// How many occurrences of `needle` start in `text` at [from, before).
function countOccurrences(
  text: string,
  needle: string,
  from: number,
  before: number
): number {
  let count = 0;
  for (
    let index = text.indexOf(needle, from);
    index !== -1 && index < before;
    index = text.indexOf(needle, index + 1)
  ) {
    count++;
  }
  return count;
}

// The index of the occurrence of `needle` in `text` after skipping `skip`
// occurrences at or past `from`, or -1 when there are not that many.
function findOccurrence(
  text: string,
  needle: string,
  from: number,
  skip: number
): number {
  let index = text.indexOf(needle, from);
  for (let n = 0; n < skip && index !== -1; n++) {
    index = text.indexOf(needle, index + 1);
  }
  return index;
}

// ::highlight() rules only reach their own stylesheet's tree, and rendered
// documents live in the light DOM rather than the viewer's shadow roots, so
// the match colors are adopted onto the document once as well, by the first
// highlighter constructed in a browser that supports highlights.
let documentStylesAdopted = false;
function adoptDocumentHighlightStyles(): void {
  if (documentStylesAdopted) {
    return;
  }
  documentStylesAdopted = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(SEARCH_HIGHLIGHT_CSS);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
