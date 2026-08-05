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
