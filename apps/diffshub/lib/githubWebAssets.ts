// Recognizes absolute URLs that the configured GitHub instance serves itself
// and that need auth on private-mode GHES: comment-author avatars and images
// pasted into comments or docs ("user-attachments"). The browser cannot
// attach credentials to cross-origin <img> requests, so these are rewritten
// through the same-origin /api/github-web-asset proxy, which forwards the
// viewer's token. Everything else (public CDNs, avatars.githubusercontent.com
// on github.com) is left untouched.
const PROXIED_PATH_PREFIXES = ['/avatars/', '/user-attachments/'];

// webURL is a per-deployment constant but this matcher runs for every image
// and avatar on every render; cache its parsed origin instead of re-parsing.
const originByWebURL = new Map<string, string | null>();

function getWebOrigin(webURL: string): string | null {
  let origin = originByWebURL.get(webURL);
  if (origin === undefined) {
    try {
      origin = new URL(webURL).origin;
    } catch {
      origin = null;
    }
    originByWebURL.set(webURL, origin);
  }
  return origin;
}

// The parsed URL when `src` is a same-instance asset the proxy may serve;
// null for anything else. Shared by the client (deciding whether to rewrite)
// and the proxy route (validating the requested URL before fetching it).
export function matchGitHubWebAsset(src: string, webURL: string): URL | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.origin !== getWebOrigin(webURL)) {
    return null;
  }
  return PROXIED_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
    ? url
    : null;
}

export function createGitHubWebAssetProxyURL(
  src: string,
  webURL: string
): string | null {
  const url = matchGitHubWebAsset(src, webURL);
  if (url == null) {
    return null;
  }
  return `/api/github-web-asset?${new URLSearchParams({ url: url.toString() })}`;
}
