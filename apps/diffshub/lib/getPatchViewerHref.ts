import { getGitHubPathFromURL } from './getGitHubPathFromURL';
import { normalizeGitHubPath } from './normalizeGitHubPath';

// Matches GitHub shorthand "owner/repo#123" -> /owner/repo/pull/123.
const GITHUB_SHORTHAND_PATTERN = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;

// Matches bare paths like "owner/repo/pull/123" where neither of the first two
// segments contains a dot; a dot would indicate a domain like "github.com".
const BARE_GITHUB_PATH_PATTERN = /^([^/\s.]+)\/([^/\s.]+)(\/[^\s]*)?$/;

// Resolves a user-supplied string into a viewer href, or undefined if the
// input can't be mapped to a supported diff URL. Accepts full URLs, URLs
// without a protocol (e.g. "github.com/..."), bare "owner/repo/..." paths, and
// GitHub shorthand ("owner/repo#123"). `githubHost` selects which hostname
// counts as "the" GitHub instance for self-hosted deployments. `appHost` is
// this app's own host: a pasted link to it opens in place instead of being
// read as a patch to fetch from that domain.
export function getPatchViewerHref(
  input: string,
  githubHost?: string,
  appHost?: string
): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  // GitHub shorthand: "owner/repo#123" -> "/owner/repo/pull/123"
  const shorthandMatch = GITHUB_SHORTHAND_PATTERN.exec(trimmed);
  if (shorthandMatch != null) {
    return `/${shorthandMatch[1]}/${shorthandMatch[2]}/pull/${shorthandMatch[3]}`;
  }

  // Full URL with protocol (most common case).
  try {
    return resolveParsedURL(new URL(trimmed), githubHost, appHost);
  } catch {
    // Not a fully-qualified URL; try other interpretations.
  }

  // Domain-relative URL like "github.com/owner/repo/pull/123" — only attempt
  // when the first path segment contains a dot, indicating it's a hostname
  // rather than an owner name. Checking only the first segment avoids false
  // positives from dots in later segments (e.g. "v6.0...v7.0" in a compare URL).
  const firstSegment = trimmed.split('/')[0] ?? '';
  if (firstSegment.includes('.')) {
    try {
      const href = resolveParsedURL(
        new URL(`https://${trimmed}`),
        githubHost,
        appHost
      );
      if (href != null) return href;
    } catch {
      // Not parseable even with https:// prefix.
    }
  }

  // Bare GitHub path: "owner/repo/pull/123" or "owner/repo/compare/a...b".
  // The dot-free first segment check above ensures we don't land here for
  // domain-style inputs. "owner/repo/123" is pull-number shorthand.
  const bareMatch = BARE_GITHUB_PATH_PATTERN.exec(trimmed);
  if (bareMatch != null) {
    const [, owner, repo, rest = ''] = bareMatch;
    const pullNumberMatch = /^\/(\d+)$/.exec(rest);
    if (pullNumberMatch != null) {
      return `/${owner}/${repo}/pull/${pullNumberMatch[1]}`;
    }
    return normalizeGitHubPath(`/${owner}/${repo}${rest}`);
  }

  return undefined;
}

// A parsed URL as a viewer href: a GitHub view, a page of this app, or a
// patch fetched from another domain. Undefined for a bare origin.
function resolveParsedURL(
  url: URL,
  githubHost: string | undefined,
  appHost: string | undefined
): string | undefined {
  const githubPath = getGitHubPathFromURL(url, githubHost);
  if (githubPath != null) return githubPath;
  if (url.pathname === '/') return undefined;
  if (appHost != null && url.host === appHost) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return `${url.pathname}?domain=${encodeURIComponent(url.hostname)}`;
}
