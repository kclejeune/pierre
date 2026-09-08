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

const AVATAR_EMAIL_WEB_PATH = '/avatars/u/e';
const AVATAR_EMAIL_API_PATH = '/enterprise/avatars/u/e';

// webURL is a per-deployment constant but these run for every image and avatar
// on every render; parse it once.
const parsedWebURLs = new Map<string, URL | null>();

function getParsedWebURL(webURL: string): URL | null {
  let parsed = parsedWebURLs.get(webURL);
  if (parsed === undefined) {
    try {
      parsed = new URL(webURL);
    } catch {
      parsed = null;
    }
    parsedWebURLs.set(webURL, parsed);
  }
  return parsed;
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
  if (url.origin !== getParsedWebURL(webURL)?.origin) {
    return null;
  }
  return PROXIED_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
    ? url
    : null;
}

export interface GitHubWebAssetUpstream {
  // True only when `url` is the instance's avatar lookup API, which GHES gates
  // on the classic `repo` OAuth scope and exposes to no GitHub App permission.
  // A viewer signed in through a GitHub App therefore cannot fetch it at all,
  // making it the one request lib/avatarCredential may pay for instead.
  isAvatarLookup: boolean;
  url: string;
}

// The URL the proxy should actually fetch for a matched asset.
//
// GHES serves /avatars/ to browser session cookies only — a PAT gets a 302 to
// /login however it is presented — so avatars must go through the email lookup
// API at <apiURL>/enterprise/avatars/u/e. There is no path-preserving
// /enterprise/avatars/u/<id> route.
//
// Everything else — user attachments, and avatar paths with no email to look up
// (org and bot avatars) — is fetched at its original URL.
export function resolveGitHubWebAssetUpstreamURL(
  assetURL: URL,
  environment: Pick<GitHubEnvironment, 'apiURL' | 'isGitHubDotCom' | 'webURL'>,
  avatarLogin?: string
): GitHubWebAssetUpstream {
  if (
    environment.isGitHubDotCom ||
    !assetURL.pathname.startsWith(AVATAR_PATH_PREFIX)
  ) {
    return { isAvatarLookup: false, url: assetURL.toString() };
  }

  const email = resolveAvatarLookupEmail(assetURL, environment, avatarLogin);
  if (email == null) {
    return { isAvatarLookup: false, url: assetURL.toString() };
  }

  const upstream = new URL(`${environment.apiURL}${AVATAR_EMAIL_API_PATH}`);
  upstream.searchParams.set('email', email);
  const size = assetURL.searchParams.get('s');
  if (size != null) {
    upstream.searchParams.set('s', size);
  }
  return { isAvatarLookup: true, url: upstream.toString() };
}

// The address to look the avatar up by, or null when this URL carries neither
// one nor enough identity to synthesize one. /avatars/u/e already has an
// `email` parameter (SAML / enterprise managed users); /avatars/u/<id> yields
// the user's generated no-reply address, which GitHub accepts in place of their
// real email.
function resolveAvatarLookupEmail(
  assetURL: URL,
  environment: Pick<GitHubEnvironment, 'webURL'>,
  avatarLogin: string | undefined
): string | null {
  if (assetURL.pathname === AVATAR_EMAIL_WEB_PATH) {
    const email = assetURL.searchParams.get('email');
    return email == null || email === '' ? null : email;
  }
  const userID = /^\/avatars\/u\/(\d+)$/.exec(assetURL.pathname)?.[1];
  if (userID == null || avatarLogin == null || avatarLogin === '') {
    return null;
  }
  const hostname = getParsedWebURL(environment.webURL)?.hostname;
  return hostname == null
    ? null
    : `${userID}+${avatarLogin}@users.noreply.${hostname}`;
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
