import { normalizeGitHubPath } from './normalizeGitHubPath';

const GITHUB_HOST = 'github.com';
const GITHUB_RAW_DIFF_HOST = 'patch-diff.githubusercontent.com';
const RAW_GITHUB_DIFF_PATH_PATTERN =
  /^\/raw\/([^/]+)\/([^/]+)\/pull\/([^/]+\.(?:diff|patch))$/;

// Maps a parsed URL to a GitHub-relative viewer path when it belongs to the
// configured GitHub instance. `githubHost` defaults to public github.com;
// self-hosted deployments pass their GHES hostname. The patch-diff raw host
// only exists for github.com, so it is skipped for other hosts.
export function getGitHubPathFromURL(
  parsedURL: URL,
  githubHost: string = GITHUB_HOST
): string | undefined {
  if (parsedURL.hostname === githubHost) {
    if (parsedURL.pathname === '/') {
      return undefined;
    }
    return normalizeGitHubPath(parsedURL.pathname);
  }

  if (
    githubHost !== GITHUB_HOST ||
    parsedURL.hostname !== GITHUB_RAW_DIFF_HOST
  ) {
    return undefined;
  }

  const rawDiffMatch = RAW_GITHUB_DIFF_PATH_PATTERN.exec(parsedURL.pathname);
  if (rawDiffMatch == null) {
    return undefined;
  }

  const owner = rawDiffMatch[1];
  const repo = rawDiffMatch[2];
  const pullFile = rawDiffMatch[3];
  if (owner == null || repo == null || pullFile == null) {
    return undefined;
  }

  return `/${owner}/${repo}/pull/${pullFile}`;
}
