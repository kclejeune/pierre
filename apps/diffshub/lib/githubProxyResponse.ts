import type { GitHubEnvironment } from './githubEnvironment';
import { createJSONResponse } from './jsonResponse';
import { logUpstreamFailure } from './serverLog';

// Shared failure responses for API routes that proxy the GitHub API, so every
// route surfaces the same actionable error messages to the browser.

// Relays a failed GitHub response to the caller, forwarding GitHub's own
// explanation when the body carries one. 401/403/404/422 are actionable for
// the caller and keep their status; 5xx collapses to a gateway-style 502.
export async function createGitHubFailureResponse(
  response: Response
): Promise<Response> {
  // response.url identifies the failing operation better than a route name
  // would, so callers do not have to thread one through.
  logUpstreamFailure({
    response,
    route: 'github-api',
    upstreamURL: response.url,
  });
  let detail = '';
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === 'string') {
      detail = payload.message;
    }
  } catch {
    // Non-JSON failure body; the status alone still tells the story.
  }
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

// The upstream fetch itself threw — DNS, TLS, or network failure — so there is
// no GitHub status to forward.
export function createUnreachableResponse(
  environment: GitHubEnvironment
): Response {
  logUpstreamFailure({
    error: `Could not reach ${environment.host}`,
    route: 'github-api',
    upstreamURL: environment.apiURL,
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
      route: 'github-api',
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
