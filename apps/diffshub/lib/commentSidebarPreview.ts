// Sidebar rows show a comment's markdown body as plain text, so markup GitHub
// renders invisibly — HTML comments like the `<!-- marker -->` lines bots
// embed for their own bookkeeping — would show literally. Strip comments and
// collapse the blank space they leave behind.
export function createCommentSidebarPreview(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Collapsed conversation rows show at most this many characters of summary
// (two lines at the sidebar's width); a longer first line has more to show.
const SUMMARY_MAX_LENGTH = 140;

// A collapsed conversation row's summary: the comment's first line of real
// text, as plain text (heading, quote, list and task markers, links, images,
// HTML, bold and code marks removed), and whether the comment holds more
// than that summary shows, so the row offers to expand. Single `*` and `_`
// are kept, since they're as often part of a name (snake_case) as emphasis.
export function summarizeCommentBody(body: string): {
  hasMore: boolean;
  summary: string;
} {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (let index = 0; index < lines.length; index++) {
    const summary = toPlainTextLine(lines[index] ?? '');
    if (summary !== '') {
      return {
        hasMore:
          index < lines.length - 1 || summary.length > SUMMARY_MAX_LENGTH,
        summary,
      };
    }
  }
  return { hasMore: lines.length > 0, summary: '' };
}

function toPlainTextLine(line: string): string {
  return line
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
