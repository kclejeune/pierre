import type { GitHubEnvironment } from './githubEnvironment';

// Recognizes absolute URLs that the configured GitHub instance serves itself
// and that need auth on private-mode GHES: comment-author avatars and images
// pasted into comments or docs ("user-attachments"). The browser cannot
// attach credentials to cross-origin <img> requests, so these are rewritten
// through the same-origin /api/github-web-asset proxy, which forwards the
// viewer's token. Everything else (public CDNs, avatars.githubusercontent.com
// on github.com) is left untouched.
const AVATAR_PATH_PREFIX = '/avatars/';
const PROXIED_PATH_PREFIXES = [AVATAR_PATH_PREFIX, '/user-attachments/'];

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

// The URL the proxy should actually fetch for a matched asset.
//
// GHES serves /avatars/ to browser session cookies only: a PAT gets a 302 to
// /login regardless of how it is presented (Bearer, token, Basic, query
// param). Its private-mode-safe avatar API is the email lookup endpoint at
// <apiURL>/enterprise/avatars/u/e, not a path-preserving
// /enterprise/avatars/u/<id> route. GitHub recognizes its generated no-reply
// address, so the numeric id from /avatars/u/<id> plus the author's login is
// enough to use that endpoint without exposing the user's real email.
//
// Everything else — user-attachment images — is fetched at its original URL.
export function resolveGitHubWebAssetUpstreamURL(
  assetURL: URL,
  environment: Pick<GitHubEnvironment, 'apiURL' | 'isGitHubDotCom' | 'webURL'>,
  avatarLogin?: string
): string {
  if (
    environment.isGitHubDotCom ||
    !assetURL.pathname.startsWith(AVATAR_PATH_PREFIX)
  ) {
    return assetURL.toString();
  }

  const userID = /^\/avatars\/u\/(\d+)$/.exec(assetURL.pathname)?.[1];
  if (userID == null || avatarLogin == null || avatarLogin === '') {
    return assetURL.toString();
  }

  const upstream = new URL(`${environment.apiURL}/enterprise/avatars/u/e`);
  upstream.searchParams.set(
    'email',
    `${userID}+${avatarLogin}@users.noreply.${new URL(environment.webURL).hostname}`
  );
  const size = assetURL.searchParams.get('s');
  if (size != null) {
    upstream.searchParams.set('s', size);
  }
  return upstream.toString();
}

export function createGitHubWebAssetProxyURL(
  src: string,
  webURL: string,
  avatarLogin?: string
): string | null {
  const url = matchGitHubWebAsset(src, webURL);
  if (url == null) {
    return null;
  }
  const search = new URLSearchParams({ url: url.toString() });
  if (avatarLogin != null && avatarLogin !== '') {
    search.set('login', avatarLogin);
  }
  return `/api/github-web-asset?${search}`;
}
