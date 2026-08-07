import { GITHUB_DOTCOM_WEB_URL } from './githubEnvironment';
import { normalizeGitHubPath } from './normalizeGitHubPath';

export type DiffshubViewerRoute =
  | { kind: 'redirect'; target: string }
  | {
      kind: 'render';
      upstreamPath: string;
      url: string;
      domain: string | undefined;
    }
  | {
      // The repo file browser: a plain tree + highlighted-file view of the
      // repository at a ref, mirroring GitHub's /tree/ and /blob/ URLs. Only
      // GitHub-instance paths get this — alternate domains have no ref API.
      kind: 'browse';
      owner: string;
      repo: string;
      view: 'tree' | 'blob';
      // Everything after the view segment: ref plus optional sub-path,
      // still joined because slash-containing branch names make the split
      // ambiguous. '' means the default branch at the repository root.
      refAndPath: string;
    };

// A bare /owner/repo path browses the default-branch root (there is no diff
// to view at that URL anyway); /tree/ and /blob/ carry the ref remainder.
const BROWSE_PATH_PATTERN = /^\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/(.+))?$/;

// Resolves the catch-all viewer route into either a redirect or the props the
// viewer needs to render. Extracted from the route page so it can be unit
// tested without spinning up Next.js. Empty paths redirect to the home page;
// GitHub paths are canonicalized via normalizeGitHubPath so direct navigation
// matches the hrefs getPatchViewerHref produces from form input. Non-GitHub
// hosts are passed through unchanged because their canonical form is unknown.
// `githubWebURL` is the configured GitHub instance origin (github.com or a
// GHES base URL) used to build the header's editable source URL.
export function resolveDiffshubViewerRoute(
  pathSegments: readonly string[],
  requestedDomainInput: string | undefined,
  githubWebURL: string = GITHUB_DOTCOM_WEB_URL
): DiffshubViewerRoute {
  if (pathSegments.length === 0) {
    return { kind: 'redirect', target: '/' };
  }

  const domain =
    requestedDomainInput == null || requestedDomainInput === ''
      ? undefined
      : requestedDomainInput;
  const joinedPath = `/${pathSegments.join('/')}`;
  const upstreamPath =
    domain == null ? normalizeGitHubPath(joinedPath) : joinedPath;

  if (upstreamPath !== joinedPath) {
    const query = domain == null ? '' : `?domain=${encodeURIComponent(domain)}`;
    return { kind: 'redirect', target: `${upstreamPath}${query}` };
  }

  if (domain == null) {
    const browseMatch = BROWSE_PATH_PATTERN.exec(upstreamPath);
    if (browseMatch != null) {
      return {
        kind: 'browse',
        owner: browseMatch[1],
        repo: browseMatch[2],
        view: browseMatch[3] === 'blob' ? 'blob' : 'tree',
        refAndPath: browseMatch[4] ?? '',
      };
    }
  }

  return {
    domain,
    kind: 'render',
    upstreamPath,
    url:
      domain == null
        ? `${githubWebURL}${upstreamPath}`
        : `https://${domain}${upstreamPath}`,
  };
}
