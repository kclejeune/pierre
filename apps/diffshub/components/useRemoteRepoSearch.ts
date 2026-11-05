'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import { searchGitHubRepos } from './githubSuggestClient';
import { useLatestValueRef } from './useLatestValueRef';
import {
  deriveRepoSearchQuery,
  goToRepoKey,
  isNewRemoteRepo,
} from '@/lib/paletteItems';
import { requestJSON } from '@/lib/pullCommentsClient';

// How long typing pauses before the remote searches run; local matches
// don't wait for them.
const REMOTE_SEARCH_DELAY_MS = 250;
// Waits between org searches while an org listing is still being built
// (about 30s in total), after which GitHub search alone covers that org.
const ORG_RETRY_DELAYS_MS = [2000, 4000, 8000, 16_000];
// Stable empty results, so a memo over them isn't invalidated by a fresh []
// on renders without remote rows.
const NO_REMOTE: readonly string[] = [];

export interface RemoteRepoResults {
  orgMatches: readonly string[];
  remote: readonly string[];
}

const NO_RESULTS: RemoteRepoResults = {
  orgMatches: NO_REMOTE,
  remote: NO_REMOTE,
};

// Results tagged with the credential version they were fetched under, so a
// credential change in another tab hides them until the new identity's
// search lands.
interface VersionedRemoteResults extends RemoteRepoResults {
  tokenVersion: number;
}

// Fuzzy matches from the viewer's organizations (server-ranked over shared
// org listings, access-checked per viewer). `pending` means some org's
// listing is still being built. A failed request (signed out, a rejected
// query, the network) is not pending: no listing is being built, so
// retrying or starting GitHub search early would only spend requests.
async function searchOrgRepos(
  query: string,
  signal: AbortSignal
): Promise<{ pending: boolean; repos: string[] }> {
  try {
    const params = new URLSearchParams({ q: query });
    return (await requestJSON(`/api/github-org-repo-search?${params}`, {
      headers: storedGitHubTokenHeaders(),
      signal,
    })) as { pending: boolean; repos: string[] };
  } catch {
    return { pending: false, repos: [] };
  }
}

// The palette's remote repository tiers for its query, debounced: org
// matches first, then GitHub's repository-name search (and its browser
// cache) only when the org matches add no new row or an org is still being
// listed, since that search API allows ~30 requests a minute. Keeps the previous
// results while the next search is pending so the list doesn't flicker on
// each keystroke. Queries that can't name a repository (empty, spaces, URLs)
// show no remote rows, derived during render rather than cleared from the
// effect. While the server reports an org listing still being built, the
// org search is retried with backoff (pending responses are never cached),
// so its matches appear without retyping. GitHub search is skipped only
// when the org matches add a row: matches that are all in `shownRepos`
// (lowercase names the local sections can already show) add nothing, so the
// fallback still runs. A credential change (`tokenVersion`) aborts the
// search in flight and runs it again for the new identity. Signed out
// (`hasToken` false) there are no organizations to search, so only GitHub's
// public search runs.
export function useRemoteRepoSearch(
  query: string,
  shownRepos: ReadonlySet<string>,
  tokenVersion: number,
  hasToken: boolean
): RemoteRepoResults {
  const [results, setResults] = useState<VersionedRemoteResults>({
    ...NO_RESULTS,
    tokenVersion,
  });
  // Read when a search settles rather than as an effect dependency, so the
  // directory loading in doesn't restart the search.
  const known = useLatestValueRef(shownRepos);
  // Whether the last org search said some org was still being listed; while
  // it is, GitHub search starts alongside the org search instead of after.
  const orgsPending = useRef(false);
  const suggestQuery = useMemo(() => deriveRepoSearchQuery(query), [query]);
  useEffect(() => {
    if (suggestQuery == null) {
      return;
    }
    // Aborting stops a superseded org search server-side too, before its
    // access check.
    const controller = new AbortController();
    let timer = 0;
    // Runs the org search and stores its matches, retrying while some org's
    // listing is still being built. A retry keeps the GitHub search rows;
    // the first search clears the previous query's. Null once aborted.
    const searchOrgs = async (attempt: number) => {
      const org = await searchOrgRepos(query.trim(), controller.signal);
      if (controller.signal.aborted) {
        return null;
      }
      orgsPending.current = org.pending;
      setResults((previous) => ({
        orgMatches: org.repos,
        remote: attempt === 0 ? NO_REMOTE : previous.remote,
        tokenVersion,
      }));
      const delay = ORG_RETRY_DELAYS_MS[attempt];
      if (org.pending && delay != null) {
        timer = window.setTimeout(() => void searchOrgs(attempt + 1), delay);
      }
      return org;
    };
    const run = async () => {
      const searchGitHub = () =>
        searchGitHubRepos(suggestQuery.owner, suggestQuery.query);
      if (!hasToken) {
        const remote = await searchGitHub();
        if (!controller.signal.aborted) {
          setResults({ orgMatches: NO_REMOTE, remote, tokenVersion });
        }
        return;
      }
      const early = orgsPending.current ? searchGitHub() : null;
      const org = await searchOrgs(0);
      if (org == null) {
        return;
      }
      // The typed "owner/name" itself already has a "Go to" row.
      const goTo = goToRepoKey(query);
      const addsRows = org.repos.some((repo) =>
        isNewRemoteRepo(repo, known.current, goTo)
      );
      if (!org.pending && addsRows) {
        return;
      }
      const remote = await (early ?? searchGitHub());
      if (!controller.signal.aborted) {
        // Keeps org matches a retry may already have replaced.
        setResults((previous) => ({ ...previous, remote }));
      }
    };
    timer = window.setTimeout(() => void run(), REMOTE_SEARCH_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [hasToken, known, query, suggestQuery, tokenVersion]);
  return suggestQuery == null || results.tokenVersion !== tokenVersion
    ? NO_RESULTS
    : results;
}
