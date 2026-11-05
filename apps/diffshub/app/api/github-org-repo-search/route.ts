import { after, type NextRequest } from 'next/server';

import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  filterAccessibleRepos,
  loadViewerOrgs,
  narrowOrgs,
  parseOrgRepoQuery,
  refreshOrgListings,
  searchOrgListings,
} from '@/lib/githubOrgRepos';
import {
  createJSONResponse,
  createPrivateJSONResponse,
} from '@/lib/jsonResponse';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import { emitLogLine, formatError } from '@/lib/serverLog';

// Fuzzy repository search across the organizations the viewer belongs to,
// for the /pulls repo switcher. Ranks the shared org listings
// (lib/githubOrgRepos) with the go-to-file matcher and returns only the
// matches the viewer can read. A stale or missing listing is rebuilt after
// the response with this viewer's token; until then that org contributes
// nothing and `pending` tells the switcher to fall back to GitHub search and
// ask again shortly. Pending responses are never cached, so that retry
// reaches the server, and neither are failed ones, so a transient GitHub
// error isn't remembered as "no matches".

const MAX_QUERY_LENGTH = 100;
// Candidates checked for access per search, and results returned. The
// overshoot leaves room for candidates the viewer can't read.
const MAX_CANDIDATES = 30;
const MAX_RESULTS = 20;

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }
  const query = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (query === '' || query.length > MAX_QUERY_LENGTH) {
    return createJSONResponse(
      { error: `q must be 1-${MAX_QUERY_LENGTH} characters.` },
      { status: 400 }
    );
  }
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Searching organization repositories requires signing in.' },
      { status: 401 }
    );
  }

  let orgs: string[];
  try {
    orgs = await loadViewerOrgs(token);
  } catch (error) {
    logSearchError(error, request.signal);
    return createJSONResponse({ pending: false, repos: [] });
  }

  const parsed = parseOrgRepoQuery(query);
  // Narrowed before searchOrgListings caps the org count, so "owner/name"
  // reaches any membership. `pending`: some org is still being listed, so
  // the switcher keeps GitHub search on.
  const { candidates, pending, stale } = await searchOrgListings(
    narrowOrgs(orgs, parsed),
    parsed,
    MAX_CANDIDATES,
    { signal: request.signal }
  );
  if (stale.length > 0) {
    after(() => refreshOrgListings(stale, token));
  }

  try {
    // A superseded keystroke's search skips the access check.
    if (request.signal.aborted) {
      return createJSONResponse({ pending: false, repos: [] });
    }
    const repos = (
      await filterAccessibleRepos(candidates, token, request.signal)
    ).slice(0, MAX_RESULTS);
    return pending
      ? createJSONResponse({ pending, repos })
      : createPrivateJSONResponse({ pending, repos }, 60);
  } catch (error) {
    logSearchError(error, request.signal);
    return createJSONResponse({ pending, repos: [] });
  }
}

// Logs a failed search, except one the client abandoned (a superseded
// keystroke aborts its request, which rejects the access check).
function logSearchError(error: unknown, signal: AbortSignal): void {
  if (
    signal.aborted ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return;
  }
  emitLogLine({
    error: formatError(error),
    event: 'github_org_repo_search_error',
    level: 'warn',
  });
}

export const GET = withRequestLog(handleGET);
