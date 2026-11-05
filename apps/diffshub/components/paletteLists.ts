'use client';

import {
  readStoredGitHubToken,
  storedGitHubTokenHeaders,
} from './githubSession';
import { loadOpenPulls } from './githubSuggestClient';
import { createCachedLookup } from '@/lib/cachedLookup';
import type { PullSuggestion } from '@/lib/diffUrlSuggestions';
import { splitRepoName } from '@/lib/pinnedRepos';
import { requestJSON } from '@/lib/pullCommentsClient';
import type { RepoDirectoryPayload } from '@/lib/repoDirectory';
import { fetchRepoRefs, type RepoRefsData } from '@/lib/repoRefs';

// The command palette's GitHub-backed lists: the viewer's repositories, and
// one repository's refs and open pull requests. Each is a module-level
// cache keyed by credential version (and repository), so reopening the
// palette or stepping back into a repository answers from memory, and a
// list never shows under another credential than the one that loaded it.
// A failure is a typed result (so the palette can tell it from loading)
// kept only briefly, so it retries on the next open, or while the palette
// stays open, without a request per render.

export type PaletteListResult<T> = { ok: true; value: T } | { ok: false };

function paletteList<T>(fetch: (key: string) => Promise<T>, valueTTL: number) {
  return createCachedLookup<string, PaletteListResult<T>>(
    async (key) => {
      try {
        return { ok: true, value: await fetch(key) };
      } catch {
        return { ok: false };
      }
    },
    {
      failureTTL: 10_000,
      isFailure: (result) => !result.ok,
      maxEntries: 16,
      valueTTL,
    }
  );
}

// Keys are JSON [tokenVersion, repo?]; the fetchers read the stored token
// themselves, so it never sits in a cache key.
const repoOf = (key: string) => (JSON.parse(key) as [number, string])[1];

// The viewer's unarchived repositories, most recently pushed first as
// GitHub lists them (the first page of /api/github-repos).
const directoryLookup = paletteList(async (): Promise<readonly string[]> => {
  const payload = (await requestJSON('/api/github-repos', {
    headers: storedGitHubTokenHeaders(),
  })) as RepoDirectoryPayload;
  return payload.repos
    .filter((repo) => !repo.archived)
    .map((repo) => repo.fullName);
}, 5 * 60_000);

const refsLookup = paletteList(
  (key): Promise<RepoRefsData> =>
    fetchRepoRefs(splitRepoName(repoOf(key)), readStoredGitHubToken()),
  60_000
);

const pullsLookup = paletteList(async (key): Promise<PullSuggestion[]> => {
  const pulls = await loadOpenPulls(repoOf(key));
  if (pulls == null) {
    throw new Error('Loading open pull requests failed.');
  }
  return pulls;
}, 60_000);

// Each returns null while loading or while skipped: pass enabled=false (or
// a null repo) whenever the palette isn't showing the list, which also stops
// the cache's background refresh. The directory needs a token.
export function usePaletteDirectory(
  tokenVersion: number,
  enabled: boolean
): PaletteListResult<readonly string[]> | null {
  return directoryLookup.useValue(
    enabled ? JSON.stringify([tokenVersion]) : null
  );
}

export function usePaletteRefs(
  repo: string | null,
  tokenVersion: number
): PaletteListResult<RepoRefsData> | null {
  return refsLookup.useValue(
    repo == null ? null : JSON.stringify([tokenVersion, repo])
  );
}

export function usePaletteOpenPulls(
  repo: string | null,
  tokenVersion: number
): PaletteListResult<PullSuggestion[]> | null {
  return pullsLookup.useValue(
    repo == null ? null : JSON.stringify([tokenVersion, repo])
  );
}
