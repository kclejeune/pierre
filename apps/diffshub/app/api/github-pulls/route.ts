import { after, type NextRequest } from 'next/server';

import { commitErrorResponse } from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  buildActivePullsRequests,
  decodePullsCursor,
  isReviewRequestScope,
  mergeActivePullsResponses,
  parseActivePullsPayload,
  parsePullInvolvements,
  type PullAudience,
} from '@/lib/githubPullSummaries';
import {
  createJSONResponse,
  createPrivateJSONResponse,
} from '@/lib/jsonResponse';
import { isValidMutedAuthor, MAX_MUTED_AUTHORS } from '@/lib/mutedAuthors';
import { isValidRepoName, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import { DEFAULT_QUERY_TEXT } from '@/lib/pullScopes';
import { hasNarrowingQualifier } from '@/lib/pullSearchQuery';
import {
  PULLS_PAGE_CACHE_FRESH_MS,
  pullsPageCache,
} from '@/lib/pullsPageCache';
import {
  isPullsProfilingEnabled,
  profilePullsSearch,
} from '@/lib/pullsSearchProfile';
import { sendActivePullsSearch } from '@/lib/pullsSearchServer';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import { emitLogLine } from '@/lib/serverLog';
import { credentialCacheScope } from '@/lib/serverLRU';

// Pull request lists for the /pulls dashboard: one GraphQL search per page,
// built from the viewer's involvement terms (?involves=, or "anyone"), an
// optional repository scope (?repos=), the query bar's GitHub search text
// (?q=), muted authors to leave out (?mute=), and a page cursor (?cursor=)
// echoed back from the previous page.

// GitHub rejects search text much longer than this, so fail fast with a
// message the query bar can show.
const MAX_QUERY_TEXT_LENGTH = 256;

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const involvesParam = params.get('involves') ?? '';
  const involves: PullAudience | undefined =
    involvesParam === 'anyone'
      ? 'anyone'
      : parsePullInvolvements(involvesParam);
  if (involves == null) {
    return createJSONResponse(
      {
        error:
          'involves must be anyone or list review-requested, authored, reviewed, commented, or assigned.',
      },
      { status: 400 }
    );
  }
  const reposParam = params.get('repos') ?? '';
  const repos = reposParam === '' ? [] : reposParam.split(',');
  if (repos.length > MAX_PINNED_REPOS || !repos.every(isValidRepoName)) {
    return createJSONResponse(
      { error: 'repos must be a short list of owner/name repositories.' },
      { status: 400 }
    );
  }
  // Requests from before the query bar existed carry no ?q=; they listed
  // open pulls, which is also the bar's default.
  const text = (params.get('q') ?? DEFAULT_QUERY_TEXT).trim();
  if (text.length > MAX_QUERY_TEXT_LENGTH) {
    return createJSONResponse(
      {
        error: `Search text is limited to ${MAX_QUERY_TEXT_LENGTH} characters.`,
      },
      { status: 400 }
    );
  }
  // "Anyone" without a repository scope or a repo:/org:/user: qualifier would
  // search every pull request on the instance.
  if (
    involves === 'anyone' &&
    repos.length === 0 &&
    !hasNarrowingQualifier(text)
  ) {
    return createJSONResponse(
      {
        error:
          'involves=anyone needs repos or a repo:, org:, or user: qualifier.',
      },
      { status: 400 }
    );
  }
  const reviewRequests = params.get('requests') ?? 'direct';
  if (!isReviewRequestScope(reviewRequests)) {
    return createJSONResponse(
      { error: 'requests must be direct or teams.' },
      { status: 400 }
    );
  }
  const muteParam = params.get('mute') ?? '';
  const mutedAuthors = muteParam === '' ? [] : muteParam.split(',');
  if (
    mutedAuthors.length > MAX_MUTED_AUTHORS ||
    !mutedAuthors.every(isValidMutedAuthor)
  ) {
    return createJSONResponse(
      {
        error: `mute must list at most ${MAX_MUTED_AUTHORS} logins or app/ bot names.`,
      },
      { status: 400 }
    );
  }
  const cursorParam = params.get('cursor');
  const cursor =
    cursorParam == null ? undefined : decodePullsCursor(cursorParam);
  if (cursorParam != null && cursor == null) {
    return createJSONResponse(
      { error: 'cursor is not a page cursor from this endpoint.' },
      { status: 400 }
    );
  }
  // GitHub's GraphQL search needs a token, and the @me qualifiers resolve to
  // whoever it belongs to.
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'A GitHub token is required to search pull requests.' },
      { status: 401 }
    );
  }
  const scope = { involves, mutedAuthors, repos, reviewRequests, text };
  // The short-lived page cache (see PULLS_PAGE_CACHE_FRESH_MS): a fresh hit
  // answers outright, a stale one answers flagged `stale` (and uncacheable
  // by the browser) so the client shows it and refetches with no-cache.
  // fetch()'s cache: 'reload' sends Cache-Control: no-cache, which is how
  // the dashboard's refresh after a mutation skips this cache.
  const cacheKey = `${credentialCacheScope(token)}\n${request.nextUrl.search}`;
  const bypassCache = (request.headers.get('cache-control') ?? '').includes(
    'no-cache'
  );
  const cached = bypassCache ? undefined : pullsPageCache.peek(cacheKey);
  const ageMs = cached == null ? 0 : Date.now() - cached.storedAt;
  // A stale page is only served as a first page: the client revalidates
  // those, but appends load-more pages as they come, so a stale later page
  // would stay on screen. Later pages past the fresh window search afresh.
  if (cached != null && (cursor == null || ageMs < PULLS_PAGE_CACHE_FRESH_MS)) {
    emitLogLine({
      ageMs,
      event: 'github_pulls_cache_hit',
      firstPage: cursor == null,
      level: 'info',
    });
    return ageMs < PULLS_PAGE_CACHE_FRESH_MS
      ? createPrivateJSONResponse(cached.body, 30)
      : createPrivateJSONResponse({ ...cached.body, stale: true }, 0);
  }
  // GraphQL rather than REST search: the page comes back along with the
  // viewer's involvement per pull. Its searches (lib/githubPullSummaries'
  // buildActivePullsRequests) go out as concurrent requests; `searchMs`
  // records each page's wall time and `requestMs` each search's own.
  const searchMs: number[] = [];
  const requestMs: Record<string, number>[] = [];
  const fetchPage = async (pageCursor: typeof cursor) => {
    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    const responses = await Promise.all(
      buildActivePullsRequests(scope, pageCursor).map(async (search) => {
        const data = await sendActivePullsSearch(search, token, request.signal);
        timings[search.alias] = Date.now() - startedAt;
        return { alias: search.alias, data };
      })
    );
    searchMs.push(Date.now() - startedAt);
    requestMs.push(timings);
    return parseActivePullsPayload(
      mergeActivePullsResponses(responses),
      pageCursor
    );
  };
  try {
    let page = await fetchPage(cursor);
    let hiddenCount = page.hiddenCount;
    // Only the first search counts muted pulls; keep it past skipped pages.
    const { mutedCount } = page;
    // Read past pages whose every hit the GitHub App can't read, so the
    // viewer lands on readable rows; time-bounded since GHE searches are slow.
    const skipDeadline = Date.now() + UNREADABLE_SKIP_BUDGET_MS;
    while (
      page.pulls.length === 0 &&
      page.nextCursor != null &&
      Date.now() < skipDeadline
    ) {
      page = await fetchPage(decodePullsCursor(page.nextCursor));
      hiddenCount += page.hiddenCount;
    }
    // One line per request with each GitHub search's duration, keyed by
    // which searches went out (the page, plus the commented subset and the
    // muted-author count when they apply), to compare against
    // handlerDurationMs.
    emitLogLine({
      event: 'github_pulls_search',
      firstPage: cursor == null,
      hiddenCount,
      level: 'info',
      mutedAuthors: mutedAuthors.length,
      pulls: page.pulls.length,
      repos: repos.length,
      requestMs,
      searchMs,
    });
    // DIFFSHUB_PULLS_PROFILE: time the query's variants (lib/pullsSearchProfile)
    // after the response is sent, on first pages only.
    if (cursor == null && isPullsProfilingEnabled()) {
      after(() => profilePullsSearch(scope, token));
    }
    const body = { ...page, hiddenCount, mutedCount };
    pullsPageCache.set(cacheKey, { body, storedAt: Date.now() });
    return createPrivateJSONResponse(body, 30);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

// How long after the first page a request may keep reading past unreadable
// pages before returning an empty page with a cursor.
const UNREADABLE_SKIP_BUDGET_MS = 3000;

export const GET = withRequestLog(handleGET);
