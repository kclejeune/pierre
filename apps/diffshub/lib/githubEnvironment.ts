// Central description of which GitHub instance this deployment talks to.
// DiffsHub defaults to public github.com, but self-hosted deployments can point
// every upstream call (web, REST API, raw file host) at a GitHub Enterprise
// Server instance through environment variables:
//
//   DIFFSHUB_GITHUB_URL        Base web URL, e.g. https://github.example.com
//   DIFFSHUB_GITHUB_API_URL    Optional REST API override. Defaults to
//                              <base>/api/v3 on GHES (the no-subdomain-isolation
//                              layout); set https://api.<host> for instances
//                              with subdomain isolation.
//   DIFFSHUB_GITHUB_RAW_URL    Optional raw-file override. Defaults to
//                              <base>/raw on GHES; set https://raw.<host> for
//                              subdomain isolation.
//   DIFFSHUB_GITHUB_CLIENT_ID / DIFFSHUB_GITHUB_CLIENT_SECRET
//                              OAuth app credentials enabling "Sign in with
//                              GitHub" instead of pasting a PAT.

export const GITHUB_DOTCOM_WEB_URL = 'https://github.com';
const GITHUB_DOTCOM_API_URL = 'https://api.github.com';
const GITHUB_DOTCOM_RAW_URL = 'https://raw.githubusercontent.com';

// Shared by every module that talks to the configured GitHub instance, so an
// API version bump or UA change happens in one place.
export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_USER_AGENT = 'pierre-diffshub';

export interface GitHubEnvironment {
  // REST API root without a trailing slash, e.g. https://github.example.com/api/v3
  apiURL: string;
  // Hostname used to recognize pasted URLs, e.g. github.example.com
  host: string;
  // True when this deployment targets public github.com, which enables
  // github.com-only affordances (cached example blobs, patch-diff host).
  isGitHubDotCom: boolean;
  // Raw file content root without a trailing slash.
  rawURL: string;
  // Web origin without a trailing slash, e.g. https://github.example.com
  webURL: string;
}

// The serializable subset of the environment that is safe to send to the
// browser (no secrets), used for URL parsing and auth affordances in the UI.
export interface GitHubClientEnvironment {
  host: string;
  isGitHubDotCom: boolean;
  oauthEnabled: boolean;
  webURL: string;
}

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

// Pure derivation so tests can exercise the URL rules without process.env.
export function resolveGitHubEnvironment(
  baseURLInput?: string,
  apiURLInput?: string,
  rawURLInput?: string
): GitHubEnvironment {
  const webURL = normalizeBaseURL(baseURLInput, 'DIFFSHUB_GITHUB_URL');
  const isGitHubDotCom = webURL === GITHUB_DOTCOM_WEB_URL;

  const apiURL =
    apiURLInput != null && apiURLInput.trim() !== ''
      ? normalizeBaseURL(apiURLInput, 'DIFFSHUB_GITHUB_API_URL')
      : isGitHubDotCom
        ? GITHUB_DOTCOM_API_URL
        : `${webURL}/api/v3`;
  const rawURL =
    rawURLInput != null && rawURLInput.trim() !== ''
      ? normalizeBaseURL(rawURLInput, 'DIFFSHUB_GITHUB_RAW_URL')
      : isGitHubDotCom
        ? GITHUB_DOTCOM_RAW_URL
        : `${webURL}/raw`;

  return {
    apiURL,
    host: new URL(webURL).hostname,
    isGitHubDotCom,
    rawURL,
    webURL,
  };
}

// Environment variables are fixed for the process lifetime, so the derived
// (and validated) environment is memoized after the first successful read.
let cachedEnvironment: GitHubEnvironment | undefined;

export function getGitHubEnvironment(): GitHubEnvironment {
  cachedEnvironment ??= resolveGitHubEnvironment(
    process.env.DIFFSHUB_GITHUB_URL,
    process.env.DIFFSHUB_GITHUB_API_URL,
    process.env.DIFFSHUB_GITHUB_RAW_URL
  );
  return cachedEnvironment;
}

export function getGitHubOAuthConfig(): GitHubOAuthConfig | undefined {
  const clientId = process.env.DIFFSHUB_GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.DIFFSHUB_GITHUB_CLIENT_SECRET?.trim();
  if (
    clientId == null ||
    clientId === '' ||
    clientSecret == null ||
    clientSecret === ''
  ) {
    return undefined;
  }
  return { clientId, clientSecret };
}

export function getGitHubClientEnvironment(): GitHubClientEnvironment {
  const environment = getGitHubEnvironment();
  // The UI flag keys off the public client id alone (not the full OAuth
  // config): statically prerendered pages bake this value at build time, and
  // requiring the secret there would force it into build environments and
  // image layers. A missing secret surfaces at the login route instead.
  const clientId = process.env.DIFFSHUB_GITHUB_CLIENT_ID?.trim();
  return {
    host: environment.host,
    isGitHubDotCom: environment.isGitHubDotCom,
    oauthEnabled: clientId != null && clientId !== '',
    webURL: environment.webURL,
  };
}

// Joins an absolute API path onto the configured API root. `new URL(path,
// base)` is intentionally avoided: an absolute path would discard a
// path-prefixed root like https://ghes.example.com/api/v3.
export function createGitHubAPIURL(
  environment: Pick<GitHubEnvironment, 'apiURL'>,
  path: string,
  searchParams?: Record<string, string>
): string {
  const url = new URL(`${environment.apiURL}${path}`);
  if (searchParams != null) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.href;
}

// Accepts a credential-less http(s) URL and strips trailing slashes so
// derived URLs concatenate cleanly. Path prefixes are kept because API roots
// like https://ghes.example.com/api/v3 need them.
function normalizeBaseURL(input: string | undefined, label: string): string {
  const trimmed = input?.trim();
  if (trimmed == null || trimmed === '') {
    return GITHUB_DOTCOM_WEB_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} is not a valid URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must be an http(s) URL: ${trimmed}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${label} must not contain credentials.`);
  }
  if (parsed.pathname !== '/' && !/^\/[\w./-]*$/.test(parsed.pathname)) {
    throw new Error(`${label} has an unsupported path: ${trimmed}`);
  }

  return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')}`;
}
