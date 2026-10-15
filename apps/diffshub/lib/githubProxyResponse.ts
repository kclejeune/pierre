import type { GitHubEnvironment } from './githubEnvironment';
import { createJSONResponse } from './jsonResponse';
import { getCurrentRouteLabel } from './requestLog';
import { logUpstreamFailure } from './serverLog';
import { asRecord } from './untypedJson';

// Shared failure responses for API routes that proxy the GitHub API, so every
// route surfaces the same actionable error messages to the browser.
//
// The route label on each logged failure comes from the ambient request scope
// rather than an argument, so a route cannot drift out of sync with the label
// its own failures are filed under.

// Used when a helper runs outside a logged route: direct helper calls in tests
// and any startup-time use have no request scope to name.
const UNKNOWN_ROUTE = 'unknown';

// Relays a failed GitHub response to the caller, forwarding GitHub's own
// explanation when the body carries one. 401/403/404/422 are actionable for
// the caller and keep their status; 5xx collapses to a gateway-style 502.
export async function createGitHubFailureResponse(
  response: Response
): Promise<Response> {
  let detail = '';
  try {
    detail = describeGitHubFailureBody(await response.json());
  } catch {
    // Non-JSON failure body; the status alone still tells the story.
  }
  logUpstreamFailure({
    error: detail === '' ? undefined : detail,
    response,
    route: getCurrentRouteLabel(UNKNOWN_ROUTE),
    upstreamURL: response.url,
  });
  return createJSONResponse(
    {
      error:
        detail === ''
          ? `GitHub responded with ${response.status}.`
          : `GitHub responded with ${response.status}: ${detail}`,
    },
    { status: response.status >= 500 ? 502 : response.status }
  );
}

// Flattens a GitHub error body into one line: the top-level `message` plus
// the `errors[]` entries that say which field failed and why. A 422's message
// alone is usually just "Validation Failed"; the actionable part (for example
// "pull_request_review_thread.line must be part of the diff") lives in
// `errors`, which GitHub sends either as strings or as
// {resource, field, code, message} objects.
export function describeGitHubFailureBody(payload: unknown): string {
  const record = asRecord(payload);
  if (record == null) {
    return '';
  }
  const message = typeof record.message === 'string' ? record.message : '';
  const details = Array.isArray(record.errors)
    ? record.errors
        .map(describeGitHubErrorEntry)
        .filter((entry) => entry !== '')
    : [];
  if (details.length === 0) {
    return message;
  }
  const joined = details.join('; ');
  return message === '' ? joined : `${message} (${joined})`;
}

function describeGitHubErrorEntry(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  const record = asRecord(entry);
  if (record == null) {
    return '';
  }
  if (typeof record.message === 'string' && record.message !== '') {
    return record.message;
  }
  return [record.resource, record.field, record.code]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');
}

// The upstream fetch itself threw — DNS, TLS, or network failure — so there is
// no GitHub status to forward.
export function createUnreachableResponse(
  environment: GitHubEnvironment,
  upstreamURL: string = environment.apiURL
): Response {
  logUpstreamFailure({
    error: `Could not reach ${environment.host}`,
    route: getCurrentRouteLabel(UNKNOWN_ROUTE),
    upstreamURL,
  });
  return createJSONResponse(
    { error: `Could not reach ${environment.host}.` },
    { status: 502 }
  );
}

// GitHub can answer 2xx with something that is not JSON at all — a private-mode
// GHES serves an HTML login interstitial as a 200. Parsing that unguarded yields
// a bare SyntaxError ("Unexpected token '<'") that no caller can act on and that
// gets reported as whatever the enclosing catch assumes, usually "could not
// reach GitHub". So every success-path parse goes through here, which logs the
// upstream failure once and describes what was served instead.
export type GitHubJSONBody =
  | { data: unknown; problem?: never }
  | { data?: never; problem: string };

export async function parseGitHubJSONBody(
  response: Response
): Promise<GitHubJSONBody> {
  try {
    return { data: await response.json() };
  } catch (error) {
    logUpstreamFailure({
      error,
      response,
      route: getCurrentRouteLabel(UNKNOWN_ROUTE),
      upstreamURL: response.url,
    });
    const contentType = response.headers.get('content-type') ?? '';
    return {
      problem:
        contentType === ''
          ? 'GitHub returned a malformed response.'
          : `GitHub returned ${contentType} where JSON was expected.`,
    };
  }
}

// The route-facing spelling: a 502 Response instead of a thrown error, for
// handlers that return their own failures.
export type GitHubJSONResult =
  | { data: unknown; failure?: never }
  | { data?: never; failure: Response };

export async function readGitHubJSON(
  response: Response
): Promise<GitHubJSONResult> {
  const body = await parseGitHubJSONBody(response);
  if (body.problem != null) {
    return {
      failure: createJSONResponse({ error: body.problem }, { status: 502 }),
    };
  }
  return { data: body.data };
}
