import { parseBearerToken } from './parseBearerToken';
import { type PlainFetch } from './plainFetch';

// Client-side relay for "a DiffsHub API route answered 401 to a request that
// carried the viewer's token". Expiry-based refresh (components/githubSession)
// only catches tokens whose stored deadline has passed; a token GitHub revoked,
// a PAT that expired on GitHub's side, or a sealed envelope the server can no
// longer open (key rotated) all look healthy locally and are only discovered
// by a 401. Client fetches to tokened API routes go through
// fetchReportingRejection, which announces those 401s as a window event; the
// session refresher mounted at the root listens and refreshes or clears the
// stored token so the login gate can take over.

// Fired on window with the rejected bearer token as `detail`.
export const GITHUB_TOKEN_REJECTED_EVENT = 'diffshub:github-token-rejected';

// `fetch`, plus the 401 report. Tokenless 401s ("sign in required") are left
// to the login gate.
export const fetchReportingRejection: PlainFetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) {
    const token = parseBearerToken(
      new Headers(init?.headers).get('authorization')
    );
    if (token != null) {
      globalThis.window?.dispatchEvent(
        new CustomEvent(GITHUB_TOKEN_REJECTED_EVENT, { detail: token })
      );
    }
  }
  return response;
};
