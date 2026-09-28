// The mdast fields this plugin reads, to avoid an @types/mdast dependency.
interface MdastNode {
  children?: MdastNode[];
  type: string;
  url?: string;
  value?: string;
}

// A GitHub login (alphanumerics, single inner hyphens, at most 39 chars) with
// an optional `/team`. The lead group rejects emails and mid-word `@`s.
const MENTION_PATTERN =
  /(^|[^\w@./`])@([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}(?:\/[\w-]+)?)/g;

// Subtrees where an `@` is literal text, never a mention.
const SKIPPED_PARENTS = new Set([
  'code',
  'definition',
  'html',
  'inlineCode',
  'link',
  'linkReference',
]);

// Splits a text value into text and mention links, or null when there are none.
export function splitMentions(
  value: string,
  webURL: string
): MdastNode[] | null {
  const nodes: MdastNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(MENTION_PATTERN)) {
    const [, lead, handle] = match;
    const start = match.index + lead.length;
    if (start > cursor) {
      nodes.push({ type: 'text', value: value.slice(cursor, start) });
    }
    const [login, team] = handle.split('/');
    nodes.push({
      type: 'link',
      url:
        team == null
          ? `${webURL}/${login}`
          : `${webURL}/orgs/${login}/teams/${team}`,
      children: [{ type: 'text', value: `@${handle}` }],
    });
    cursor = start + handle.length + 1;
  }
  if (nodes.length === 0) {
    return null;
  }
  if (cursor < value.length) {
    nodes.push({ type: 'text', value: value.slice(cursor) });
  }
  return nodes;
}

// Replaces mention text nodes, rebuilding a children array only when something
// splits.
function linkMentionsIn(node: MdastNode, webURL: string): void {
  if (node.children == null || SKIPPED_PARENTS.has(node.type)) {
    return;
  }
  let next: MdastNode[] | null = null;
  node.children.forEach((child, index) => {
    const split =
      child.type === 'text' && child.value?.includes('@') === true
        ? splitMentions(child.value, webURL)
        : null;
    if (split == null) {
      linkMentionsIn(child, webURL);
      next?.push(child);
    } else {
      next ??= node.children!.slice(0, index);
      next.push(...split);
    }
  });
  if (next != null) {
    node.children = next;
  }
}

// Links `@login` and `@org/team` mentions. Comments only; GitHub doesn't link
// them in rendered files.
export function remarkMentions(options: { webURL: string }) {
  return (tree: MdastNode) => linkMentionsIn(tree, options.webURL);
}
