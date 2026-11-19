'use client';

import { useEffect, useMemo, useState } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import {
  MAX_PULL_STATUS_IDS,
  type PullStatus,
  type PullSummary,
} from '@/lib/githubPullSummaries';
import { requestJSON } from '@/lib/pullCommentsClient';
import {
  applyPullStatuses,
  markPullStatusesInFlight,
  pullsNeedingStatus,
  storePullStatuses,
  subscribePullStatuses,
} from '@/lib/pullStatusCache';

// Fills in the list rows' CI and review state, which the list search leaves
// out (see PULL_STATUSES_QUERY): whenever the rows change (the first page,
// a load-more, a refetch), the rows without a fresh status that no other
// read is already fetching (lib/pullStatusCache) are read from
// /api/pull-statuses, a page's worth per request, and merged in as they
// land. Reads aren't aborted when the rows change: their answers are cached
// for the next list that shows those pulls, and replacing the rows with
// equal ones (cached rows, then the network's) would otherwise throw away a
// read only to send it again. A failed read leaves those rows without
// badges rather than showing an error. `pending` holds the pullKeys of rows
// still waiting, so they can hold the CI glyph's place.
export function usePullStatuses(
  pulls: readonly PullSummary[],
  tokenVersion: number
): { pending: ReadonlySet<string>; pulls: PullSummary[] } {
  // Bumped when any read lands, so the merge below re-reads the cache.
  const [storedVersion, setStoredVersion] = useState(0);
  useEffect(
    () =>
      subscribePullStatuses(() => setStoredVersion((version) => version + 1)),
    []
  );

  useEffect(() => {
    const needed = pullsNeedingStatus(pulls, tokenVersion, Date.now());
    for (let start = 0; start < needed.length; start += MAX_PULL_STATUS_IDS) {
      const chunk = needed.slice(start, start + MAX_PULL_STATUS_IDS);
      markPullStatusesInFlight(chunk, tokenVersion);
      const params = new URLSearchParams({
        ids: chunk.map((pull) => pull.nodeId).join(','),
        // Each row's updatedAt, so the server's short-lived status cache
        // re-reads a pull that changed (lib/pullStatusesServer).
        v: chunk.map((pull) => pull.updatedAt).join(','),
      });
      requestJSON(`/api/pull-statuses?${params}`, {
        headers: storedGitHubTokenHeaders(),
      }).then(
        (payload) => {
          const statuses = (
            payload as { statuses?: Record<string, PullStatus> }
          ).statuses;
          storePullStatuses(chunk, tokenVersion, statuses ?? {}, Date.now());
        },
        () => storePullStatuses(chunk, tokenVersion, {}, Date.now())
      );
    }
  }, [pulls, tokenVersion]);

  return useMemo(
    () => applyPullStatuses(pulls, tokenVersion),
    // storedVersion is the cache's change signal.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [pulls, tokenVersion, storedVersion]
  );
}
