// The pathnames the /pulls dashboard lives at. A repository scope uses
// GitHub's own shape, /owner/repo/pulls (served by a rewrite onto the /pulls
// page in next.config.mjs), so swapping the host of a GitHub pull request
// list URL lands on the same list here. Every other scope is plain /pulls.
// Kept light (only the path encoder) so the queue and recents modules can
// share the check without pulling in the dashboard's search code.

import { encodePath } from './githubDiffSource';

// Segments exclude backslashes as well as slashes: browsers read `/\host`
// as `//host`, and the queue renders a stored path as a link, so a segment
// starting with one would point off-site.
const PULLS_LIST_PATH_PATTERN =
  /^\/(?:([^/\\?#\s]+)\/([^/\\?#\s]+)\/)?pulls\/?(?:[?#]|$)/;

// The dashboard pathname for a scope: /owner/repo/pulls for one repository,
// /pulls otherwise.
export function pullsListPathname(repo: string | null): string {
  return repo == null ? '/pulls' : `/${encodePath(repo)}/pulls`;
}

// The owner/repo a pathname scopes the dashboard to, or null for plain
// /pulls and anything that isn't a dashboard path.
export function readPullsPathRepo(pathname: string): string | null {
  const match = PULLS_LIST_PATH_PATTERN.exec(pathname);
  if (match?.[1] == null || match[2] == null) {
    return null;
  }
  try {
    return `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
  } catch {
    // A malformed escape (e.g. /a%/b/pulls) scopes nothing.
    return null;
  }
}

// Whether a same-origin path (with any query or hash) is the dashboard,
// either /pulls or /owner/repo/pulls.
export function isPullsListPath(path: string): boolean {
  return PULLS_LIST_PATH_PATTERN.test(path);
}
