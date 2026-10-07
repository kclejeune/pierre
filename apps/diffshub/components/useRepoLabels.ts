'use client';

import { storedGitHubTokenHeaders } from './githubSession';
import { useGitHubToken } from './useGitHubToken';
import { createCachedLookup } from '@/lib/cachedLookup';
import type { PullLabel } from '@/lib/pullInfoClient';
import { fetchReportingRejection } from '@/lib/rejectedCredential';

type RepoLabelsResult =
  | { kind: 'error'; message: string }
  | { kind: 'ready'; labels: PullLabel[] };

// Keyed by credential version and repo so the list survives the details
// panel unmounting on close. Failures resolve to an error result (not null)
// so the picker can tell them apart from loading.
const repoLabelsByKey = createCachedLookup(
  async (key: string): Promise<RepoLabelsResult> => {
    const [, owner, repo] = JSON.parse(key) as [number, string, string];
    try {
      const response = await fetchReportingRejection(
        `/api/pull-labels?${new URLSearchParams({ owner, repo })}`,
        { headers: storedGitHubTokenHeaders() }
      );
      const payload = (await response.json()) as {
        error?: string;
        labels?: PullLabel[];
      };
      return response.ok && payload.labels != null
        ? { kind: 'ready', labels: payload.labels }
        : { kind: 'error', message: payload.error ?? 'Loading labels failed.' };
    } catch {
      return { kind: 'error', message: 'Loading labels failed.' };
    }
  },
  { maxEntries: 16, valueTTL: 60_000 }
);

// The repository's labels, or null while loading. Pass null to skip.
export function useRepoLabels(
  repo: { owner: string; repo: string } | null
): RepoLabelsResult | null {
  const { tokenVersion } = useGitHubToken();
  return repoLabelsByKey.useValue(
    repo == null ? null : JSON.stringify([tokenVersion, repo.owner, repo.repo])
  );
}
