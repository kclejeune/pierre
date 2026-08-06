import type { GitHubEnvironment } from './githubEnvironment';
import { createJSONResponse } from './jsonResponse';

// Shared failure responses for API routes that proxy the GitHub API, so every
// route surfaces the same actionable error messages to the browser.

// Relays a failed GitHub response to the caller, forwarding GitHub's own
// explanation when the body carries one. 401/403/404/422 are actionable for
// the caller and keep their status; 5xx collapses to a gateway-style 502.
export async function createGitHubFailureResponse(
  response: Response
): Promise<Response> {
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
  return createJSONResponse(
    { error: `Could not reach ${environment.host}.` },
    { status: 502 }
  );
}
