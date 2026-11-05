import { after, type NextRequest } from 'next/server';

import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  filterAccessibleRepos,
  listingNeedsRefresh,
  loadOrgListing,
  loadViewerOrgs,
  narrowOrgs,
  type OrgRepoListing,
  parseOrgRepoQuery,
  rankOrgRepos,
  refreshOrgListings,
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
// reaches the server.

const MAX_QUERY_LENGTH = 100;
const MAX_SEARCHED_ORGS = 30;
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
    logSearchError(error);
    return createPrivateJSONResponse({ pending: false, repos: [] }, 30);
  }

  const parsed = parseOrgRepoQuery(query);
  const listings = await Promise.all(
    // Capped after narrowing, so "owner/name" reaches any membership.
    narrowOrgs(orgs, parsed)
      .slice(0, MAX_SEARCHED_ORGS)
      .map(async (org) => ({
        listing: await loadOrgListing(org),
        org,
      }))
  );
  const stale = listings.filter(({ listing }) => listingNeedsRefresh(listing));
  if (stale.length > 0) {
    after(() =>
      refreshOrgListings(
        stale.map(({ org }) => org),
        token
      )
    );
  }

  const ready = listings
    .map(({ listing }) => listing)
    .filter((listing): listing is OrgRepoListing => listing != null);
  let repos: string[] = [];
  try {
    // A superseded keystroke's search skips the access check.
    if (request.signal.aborted) {
      return createJSONResponse({ pending: false, repos: [] });
    }
    repos = (
      await filterAccessibleRepos(
        rankOrgRepos(ready, parsed, MAX_CANDIDATES),
        token,
        request.signal
      )
    ).slice(0, MAX_RESULTS);
  } catch (error) {
    logSearchError(error);
  }
  // Orgs still being listed; the switcher keeps GitHub search on.
  const pending = listings.some(({ listing }) => listing == null);
  return pending
    ? createJSONResponse({ pending, repos })
    : createPrivateJSONResponse({ pending, repos }, 60);
}

function logSearchError(error: unknown): void {
  emitLogLine({
    error: formatError(error),
    event: 'github_org_repo_search_error',
    level: 'warn',
  });
}

export const GET = withRequestLog(handleGET);
