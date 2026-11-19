// Sends the /pulls list's GitHub searches (lib/githubPullSummaries'
// buildActivePullsRequests), shared by the list route and the opt-in
// profiler (lib/pullsSearchProfile) so the profiler times exactly what the
// route sends.

import {
  ACCESS_FIELD_ERRORS,
  type GraphQLErrorTolerance,
  sendGitHubGraphQL,
} from './githubCommitServer';
import { githubFetch } from './githubFetch';
import type { ActivePullsRequest } from './githubPullSummaries';

// A GitHub App token searches every repo the user can see but reads only
// those where the app is installed; each other hit is a null node with an
// access error. Those rows are dropped rather than failing the page, for
// the searches that list nodes (the unmuted count lists none).
function searchTolerance(
  alias: ActivePullsRequest['alias']
): GraphQLErrorTolerance {
  return { types: ACCESS_FIELD_ERRORS, paths: [[alias, 'nodes']] };
}

// Sends one of a page's searches. `signal` (a superseded request's abort)
// stops the GitHub call too.
export function sendActivePullsSearch(
  search: ActivePullsRequest,
  token: string,
  signal?: AbortSignal
): Promise<unknown> {
  return sendGitHubGraphQL(
    search.query,
    search.variables,
    token,
    (url, init) => githubFetch(url, { ...init, signal }),
    { tolerate: searchTolerance(search.alias) }
  );
}
