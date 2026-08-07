import {
  encodePath,
  type GitHubDiffSource,
  parseGitHubDiffSource,
} from './githubDiffSource';
import { buildBrowseBlobPath, formatPullHeadRef } from './repoBrowser';

// URL handling for references made by a rendered markdown document. The
// document lives at a path inside the repository, so relative references
// resolve against its directory (GitHub's rendering semantics). Image
// references are served through the /api/github-doc-asset proxy, which
// fetches them from the raw file host at the diff's resolved ref; link
// references point back at the file on the GitHub instance.

// Parses a reference against the document's directory. file:/// gives URL
// resolution a rooted base, so ./ and ../ segments collapse with the same
// semantics GitHub applies and a leading / resolves from the repository
// root. Returns null when the reference already points somewhere loadable
// as-is (absolute URLs) or is not a file reference at all (anchors, empty).
function resolveDocRelativeURL(reference: string, docPath: string): URL | null {
  if (
    reference === '' ||
    reference.startsWith('#') ||
    reference.startsWith('//')
  ) {
    return null;
  }
  // Any scheme-qualified URL (https:, data:, mailto:, …) loads directly.
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    return null;
  }
  try {
    return new URL(reference, `file:///${docPath}`);
  } catch {
    return null;
  }
}

// The repository path a resolved doc-relative URL names, or null when it
// resolves to nothing (e.g. a bare "/").
function resolveDocRepoPath(resolved: URL): string | null {
  const path = decodeURIComponent(resolved.pathname).replace(/^\/+/, '');
  return path === '' ? null : path;
}

// Resolves an image reference to a repository path, or null when the
// reference should load as-is.
export function resolveDocAssetPath(
  src: string,
  docPath: string
): string | null {
  const resolved = resolveDocRelativeURL(src, docPath);
  return resolved == null ? null : resolveDocRepoPath(resolved);
}

export function createDocAssetURL(
  sourcePath: string,
  file: string,
  side: 'old' | 'new'
): string {
  const params = new URLSearchParams({ file, path: sourcePath });
  if (side === 'old') {
    params.set('side', 'old');
  }
  return `/api/github-doc-asset?${params}`;
}

export interface DocLinkTarget {
  // The repository path the link names, for looking the file up in the diff.
  path: string;
  // The file in the app's own repo browser at the diff's head ref, so the
  // link resolves even when the file is not part of the diff.
  url: string;
}

// Resolves a link reference in a rendered document to the repository file it
// names, or null when the link should be left alone (absolute URLs, anchors,
// sources whose head ref has no client-side name).
export function resolveDocLinkTarget(
  href: string,
  docPath: string,
  sourcePath: string
): DocLinkTarget | null {
  const resolved = resolveDocRelativeURL(href, docPath);
  if (resolved == null) {
    return null;
  }
  const path = resolveDocRepoPath(resolved);
  if (path == null) {
    return null;
  }
  const source = parseGitHubDiffSource(`/${sourcePath.replace(/^\/+/, '')}`);
  if (source == null) {
    return null;
  }
  const ref = resolveHeadRefName(source);
  if (ref == null) {
    return null;
  }
  // Directory links land on /blob/ too; the browser shows the tree with the
  // directory revealed. The fragment survives so heading links keep their
  // target.
  return {
    path,
    url: `${buildBrowseBlobPath(source.repo, ref, path)}${resolved.hash}`,
  };
}

// The diff's head ref in a form both the app's repo browser and the GitHub
// web UI resolve: every PR advertises refs/pull/N/head, commits use their
// own sha, and same-repo compares use the head side of the range. Fork
// compare heads (owner:branch) live in another repository, so those links
// get no target.
function resolveHeadRefName(source: GitHubDiffSource): string | null {
  switch (source.kind) {
    case 'pull':
      return formatPullHeadRef(source.number);
    case 'commit':
      return source.sha;
    case 'compare': {
      const head = source.range.split(/\.{2,3}/).pop() ?? '';
      return head === '' || head.includes(':') ? null : encodePath(head);
    }
  }
}
