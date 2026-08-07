import GithubSlugger from 'github-slugger';
import type { Element as HastElement, Root as HastRoot } from 'hast';
import { toString } from 'hast-util-to-string';

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// Stamps GitHub-compatible slug ids onto every heading so the fragment links
// documents carry (tables of contents, links into sections of other docs)
// have an element to scroll to when the document renders in the viewer.
// github-slugger reproduces GitHub's own slug rules, including the -1/-2
// suffixes on repeated heading text. rehype-sanitize later renames each id to
// `user-content-<slug>` — the same clobber GitHub applies — so DOM lookups
// must try the prefixed form.
export function rehypeGitHubHeadingIds() {
  return (tree: HastRoot) => {
    const slugger = new GithubSlugger();
    const visit = (node: HastRoot | HastElement) => {
      for (const child of node.children) {
        if (child.type !== 'element') {
          continue;
        }
        if (HEADING_TAGS.has(child.tagName) && child.properties.id == null) {
          child.properties.id = slugger.slug(toString(child));
          continue;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

// DOM ids to try for a document fragment, in order: rehype-sanitize renames
// every id to `user-content-<id>` (GitHub's own clobber), so the prefixed
// form is the common case and the bare id is the fallback.
export function headingIdCandidates(fragment: string): string[] {
  return [`user-content-${fragment}`, fragment];
}
