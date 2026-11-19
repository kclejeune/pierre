'use client';

import { useEffect, useState } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import { useGitHubToken } from './useGitHubToken';
import { createCachedLookup } from '@/lib/cachedLookup';
import { requestJSON } from '@/lib/pullCommentsClient';
import type { ReviewerCandidate } from '@/lib/pullInfoClient';

export type ReviewerCandidatesResult =
  | { kind: 'error'; message: string }
  | { candidates: ReviewerCandidate[]; kind: 'ready' };

// How long typing pauses before the picker searches, so each keystroke
// doesn't become a GitHub query.
const SEARCH_DEBOUNCE_MS = 250;

// Keyed by credential version, repo, and search text, so reopening the
// picker or retyping a recent search answers from memory. Failures resolve
// to an error result (not null) so the picker can tell them from loading,
// and are kept only briefly so reopening the picker retries.
const candidatesByKey = createCachedLookup(
  async (key: string): Promise<ReviewerCandidatesResult> => {
    const [, owner, repo, q] = JSON.parse(key) as [
      number,
      string,
      string,
      string,
    ];
    try {
      const payload = (await requestJSON(
        `/api/pull-reviewers?${new URLSearchParams({ owner, q, repo })}`,
        { headers: storedGitHubTokenHeaders() }
      )) as { candidates?: ReviewerCandidate[] };
      return { candidates: payload.candidates ?? [], kind: 'ready' };
    } catch (error) {
      return {
        kind: 'error',
        message:
          error instanceof Error ? error.message : 'Loading reviewers failed.',
      };
    }
  },
  {
    isFailure: (result) => result.kind === 'error',
    maxEntries: 32,
    valueTTL: 60_000,
  }
);

// Users the reviewer picker can offer for `repo` matching `query` (searched
// after a short pause in typing), or null while loading. Also null while
// `query` is still settling, so the picker never shows (or lets Enter pick
// from) the previous search's results under the new text. Pass null to
// skip.
export function useReviewerCandidates(
  repo: { owner: string; repo: string } | null,
  query: string
): ReviewerCandidatesResult | null {
  const { tokenVersion } = useGitHubToken();
  const [settledQuery, setSettledQuery] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(
      () => setSettledQuery(query.trim()),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [query]);
  const result = candidatesByKey.useValue(
    repo == null
      ? null
      : JSON.stringify([tokenVersion, repo.owner, repo.repo, settledQuery])
  );
  return settledQuery === query.trim() ? result : null;
}
