import type { DiffLocation, DiffSearchSide } from './diffSearch';

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
  private rowsByItem = new Map<string, Map<string, DiffLocation[]>>();
  private active: DiffLocation | null = null;
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
  }

  setMatches(
    matches: readonly DiffLocation[],
    active: DiffLocation | null
  ): void {
    this.rowsByItem = new Map();
    for (const match of matches) {
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
          for (const match of matches) {
            const range = createRowRange(row, match.start, match.end);
            if (range != null) {
              (match === this.active ? activeHighlight : matchHighlight).add(
                range
              );
            }
          }
        });
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

// Maps a character range of a row's text onto its token spans. Rows are a
// flat run of text nodes (one or more per syntax token), so walking them in
// order and counting characters lands on the right node and offset.
function createRowRange(row: Element, start: number, end: number) {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  let node: Node | null;
  while ((node = walker.nextNode()) != null) {
    const length = node.textContent?.length ?? 0;
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
