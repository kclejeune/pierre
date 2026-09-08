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
//                              GitHub App or OAuth App credentials enabling
//                              "Sign in with GitHub" instead of pasting a PAT.
//   DIFFSHUB_ENABLE_PAT_INPUT  Whether the UI offers the manual PAT paste
//                              box; see isPATInputEnabled for the default.
//   DIFFSHUB_REFRESH_TOKEN_MAX_TTL
//                              How refresh tokens may reach the browser; see
//                              getRefreshTokenMaxTTLSeconds.
//   DIFFSHUB_TOKEN_ENCRYPTION_KEY
//                              Opt-in at-rest encryption of browser-held
//                              credentials; see getTokenEncryptionKey.
//   DIFFSHUB_AVATAR_TOKEN      Server-held token for GHES avatar lookups only;
//                              see getAvatarLookupToken.

import { readNonEmptyString } from './githubOAuthGrant';
import { createJSONResponse } from './jsonResponse';
import { parseBearerToken } from './parseBearerToken';
import { isSealedToken } from './tokenEnvelope';

export const GITHUB_DOTCOM_WEB_URL = 'https://github.com';
const GITHUB_DOTCOM_API_URL = 'https://api.github.com';
const GITHUB_DOTCOM_RAW_URL = 'https://raw.githubusercontent.com';

// Shared by every module that talks to the configured GitHub instance, so an
// API version bump or UA change happens in one place.
export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_USER_AGENT = 'pierre-diffshub';

// The standard header set for JSON REST calls against the configured GitHub
// instance, with a bearer token when one is available.
export function createGitHubJSONHeaders(
  token: string | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  if (token != null && token !== '') {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// Whether this deployment gates pages and API routes behind a saved token.
// DIFFSHUB_REQUIRE_LOGIN=1/true forces it on and 0/false forces it off; when
// unset, self-hosted (non-github.com) deployments default to requiring login.
// A GitHub Enterprise instance is private by definition, so there is nothing
// an anonymous visitor could usefully read there — every request is served
// with the caller's own token or not at all, and the gate simply turns the
// resulting wall of 401s into a sign-in prompt.
export function isLoginRequired(): boolean {
  return (
    parseBooleanEnv(process.env.DIFFSHUB_REQUIRE_LOGIN) ??
    !getGitHubEnvironment().isGitHubDotCom
  );
}

// The shared contract for boolean DIFFSHUB_* flags: 1/true forces on, 0/false
// forces off, anything else (including unset) means "use the default".
function parseBooleanEnv(value: string | undefined): boolean | undefined {
  switch (value?.trim().toLowerCase()) {
    case '1':
    case 'true':
      return true;
    case '0':
    case 'false':
      return false;
    default:
      return undefined;
  }
}

// Whether the UI offers the manual PAT paste box. Hiding it keeps long-lived
// PATs out of localStorage and puts every viewer on the OAuth flow
// (short-lived, revocable, centrally managed tokens). When unset, the default
// follows that reasoning: a require-login deployment with OAuth configured
// hides the box, but one without OAuth keeps it — the PAT is then the only
// way through the login gate, and hiding it would lock everyone out. Token
// encryption overrides the flag because client-supplied PATs cannot be sealed
// by the OAuth callback and the server rejects every bare credential.
export function isPATInputEnabled(): boolean {
  if (getTokenEncryptionKey() != null) {
    return false;
  }
  return (
    parseBooleanEnv(process.env.DIFFSHUB_ENABLE_PAT_INPUT) ??
    !(isLoginRequired() && getOAuthClientId() != null)
  );
}

// The public OAuth client id, the one signal for "Sign in with GitHub can be
// offered". Deliberately not the full OAuth config: statically prerendered
// pages bake this at build time, and requiring the secret there would force
// it into build environments and image layers. A missing secret surfaces at
// the login route instead.
function getOAuthClientId(): string | undefined {
  const clientId = process.env.DIFFSHUB_GITHUB_CLIENT_ID?.trim();
  return clientId === '' ? undefined : clientId;
}

// Maximum absolute session age in seconds, from
// DIFFSHUB_REFRESH_TOKEN_MAX_TTL: undefined leaves GitHub's own refresh-token
// lifetime (six months) untouched, 0 stops refresh tokens from being issued
// at all, and a positive value is enforced server-side — see
// lib/refreshTokenWrap for the mechanism.
//
// Like the instance environment above, the value is fixed for the process
// lifetime and memoized after the first read, which also surfaces a malformed
// value at the first request rather than on every one. The box distinguishes
// "not yet read" from "read, and unset".
let cachedMaxTTL: { seconds: number | undefined } | undefined;

export function getRefreshTokenMaxTTLSeconds(): number | undefined {
  cachedMaxTTL ??= {
    seconds: parseDurationSeconds(
      process.env.DIFFSHUB_REFRESH_TOKEN_MAX_TTL,
      'DIFFSHUB_REFRESH_TOKEN_MAX_TTL'
    ),
  };
  return cachedMaxTTL.seconds;
}

// Parses an operator-supplied duration: a bare number is seconds, and the
// s/m/h/d suffixes cover the spans people actually configure (`24h`, `7d`).
// Zero is a valid, meaningful value (the refresh-token policy reads it as
// "issue none"); anything unparseable throws rather than silently running
// without the cap.
export function parseDurationSeconds(
  input: string | undefined,
  label: string
): number | undefined {
  const trimmed = input?.trim();
  if (trimmed == null || trimmed === '') {
    return undefined;
  }
  const match = /^(\d+)([smhd])?$/.exec(trimmed.toLowerCase());
  if (match == null) {
    throw new Error(
      `${label} must be a duration like 86400, 24h, or 7d: ${trimmed}`
    );
  }
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86_400,
  };
  return Number(match[1]) * multipliers[match[2] ?? 's'];
}

// Key for sealing browser-held credentials into AES-256-GCM envelopes, from
// DIFFSHUB_TOKEN_ENCRYPTION_KEY (base64, exactly 32 bytes — e.g.
// `openssl rand -base64 32`). Unset leaves tokens in the clear, exactly as
// before the option existed; set, every grant leaves the server sealed and
// the API routes decrypt on arrival — see lib/tokenSeal for the mechanism.
// Deliberately independent of the OAuth client secret so PAT-only
// deployments can use it, and so rotating one credential does not silently
// revoke the other's sessions.
let cachedEncryptionKey:
  | { key: Uint8Array<ArrayBuffer> | undefined }
  | undefined;

export function getTokenEncryptionKey(): Uint8Array<ArrayBuffer> | undefined {
  cachedEncryptionKey ??= {
    key: parseEncryptionKey(process.env.DIFFSHUB_TOKEN_ENCRYPTION_KEY),
  };
  return cachedEncryptionKey.key;
}

// Throws on a malformed value rather than silently running unencrypted: an
// operator who set the variable expects sealing to be in force.
function parseEncryptionKey(
  input: string | undefined
): Uint8Array<ArrayBuffer> | undefined {
  const trimmed = input?.trim();
  if (trimmed == null || trimmed === '') {
    return undefined;
  }
  const key = new Uint8Array(Buffer.from(trimmed, 'base64'));
  if (key.length !== 32) {
    throw new Error(
      'DIFFSHUB_TOKEN_ENCRYPTION_KEY must be 32 base64-encoded bytes (openssl rand -base64 32).'
    );
  }
  return key;
}

// The one credential the server may hold of its own: a classic GitHub token
// used for nothing but GHES avatar lookups — see lib/avatarCredential. Blank
// counts as unset. Unmemoized because there is no parse cost to cache.
export function getAvatarLookupToken(): string | undefined {
  return readNonEmptyString(process.env.DIFFSHUB_AVATAR_TOKEN);
}

export const LOGIN_REQUIRED_MESSAGE =
  'This deployment requires signing in to load GitHub data.';

// Server-side enforcement of DIFFSHUB_REQUIRE_LOGIN for API routes: true when
// a tokenless request must be refused on a require-login deployment. Every
// anonymously reachable read route checks this before doing upstream work, so
// the client-side login gate cannot be bypassed by requesting the APIs
// directly.
export function isTokenlessRequestBlocked(request: {
  headers: { get(name: string): string | null };
}): boolean {
  if (!isLoginRequired()) {
    return false;
  }
  const token = parseBearerToken(request.headers.get('authorization'));
  return (
    token == null || (getTokenEncryptionKey() != null && !isSealedToken(token))
  );
}

// The JSON form of the refusal: a 401 when the request must be blocked, null
// when it may proceed.
export function rejectTokenlessRequestWhenLoginRequired(request: {
  headers: { get(name: string): string | null };
}): Response | null {
  if (!isTokenlessRequestBlocked(request)) {
    return null;
  }
  return createJSONResponse({ error: LOGIN_REQUIRED_MESSAGE }, { status: 401 });
}

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
  // False hides the manual PAT paste box and token-creation links, leaving
  // OAuth sign-in as the only offered method (DIFFSHUB_ENABLE_PAT_INPUT).
  patInputEnabled: boolean;
  // When DIFFSHUB_REQUIRE_LOGIN is set, every page is gated behind a saved
  // token: anonymous visitors are redirected to /login and returned to their
  // original URL after signing in. The redirect is client-side (the token
  // lives in localStorage); the API routes enforce the same rule server-side
  // via rejectTokenlessRequestWhenLoginRequired.
  requireLogin: boolean;
  // True means browser-held credentials must use the server-sealed envelope
  // format. Clients clear older bare sessions and require a fresh OAuth login.
  tokenEncryptionRequired: boolean;
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

// Drops the memoized environment so a test can point the deployment at a
// different instance mid-run. Production never needs this: the variables are
// fixed for the process lifetime.
export function resetGitHubEnvironmentCache(): void {
  cachedEnvironment = undefined;
  cachedMaxTTL = undefined;
  cachedEncryptionKey = undefined;
}

// Whether a URL sits on the configured instance's web origin. Every code path
// that attaches a viewer's token to an outbound request must pass this first,
// so a credential is never handed to a host that is not the viewer's own
// GitHub instance — some upstream URLs are derived rather than typed (the
// cached example patches resolve to a CDN), and those must not inherit auth.
//
// Compares origins rather than the raw webURL string so a path-prefixed root
// (https://ghes.example.com/github) still matches its own hosts.
export function isConfiguredGitHubInstanceURL(url: string): boolean {
  try {
    return (
      new URL(url).origin === new URL(getGitHubEnvironment().webURL).origin
    );
  } catch {
    return false;
  }
}

export function getGitHubOAuthConfig(): GitHubOAuthConfig | undefined {
  const clientId = getOAuthClientId();
  const clientSecret = process.env.DIFFSHUB_GITHUB_CLIENT_SECRET?.trim();
  if (clientId == null || clientSecret == null || clientSecret === '') {
    return undefined;
  }
  return { clientId, clientSecret };
}

export function getGitHubClientEnvironment(): GitHubClientEnvironment {
  const environment = getGitHubEnvironment();
  return {
    host: environment.host,
    isGitHubDotCom: environment.isGitHubDotCom,
    oauthEnabled: getOAuthClientId() != null,
    patInputEnabled: isPATInputEnabled(),
    requireLogin: isLoginRequired(),
    tokenEncryptionRequired: getTokenEncryptionKey() != null,
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
