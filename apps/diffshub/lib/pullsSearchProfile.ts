// Opt-in latency profiling for the /pulls list. With DIFFSHUB_PULLS_PROFILE=1,
// each first-page /api/github-pulls request re-runs its GitHub requests after
// the response is sent and logs each one's duration as one
// `github_pulls_profile` line:
//
//   pullsOnly / commentedOnly / unmutedOnly
//     each of the page's searches (lib/githubPullSummaries'
//     buildActivePullsRequests) alone; unmutedOnly only when muting applies
//   parallelPage
//     all of the page's searches as concurrent requests, as the route sends
//     them
//   splitInvolvements
//     the main search once per involvement term ("authored", "assigned",
//     ...) instead of one OR of all of them, all at once: whether splitting
//     the OR, which GitHub's search handles slowly, would beat it
//   statuses6 / statuses12 / statuses25
//     the page's CI and review state (PULL_STATUSES_QUERY) read in parallel
//     chunks of 6, 12, or 25 pulls, for tuning PULL_STATUS_CHUNK_SIZE
//
// This sends about ten extra GitHub requests per first page with the
// viewer's token, so it is meant for short diagnostic runs, not for leaving
// on.

import { parseBooleanEnv } from './githubEnvironment';
import {
  type ActivePullsRequest,
  buildActivePullsRequests,
  effectivePullInvolvements,
  parseActivePullsPayload,
} from './githubPullSummaries';
import { sendActivePullsSearch } from './pullsSearchServer';
import { readPullStatuses } from './pullStatusesServer';
import { emitLogLine, formatError } from './serverLog';

type PullsSearchScope = Parameters<typeof buildActivePullsRequests>[0];

export function isPullsProfilingEnabled(): boolean {
  return parseBooleanEnv(process.env.DIFFSHUB_PULLS_PROFILE) === true;
}

// The status chunk sizes a run compares.
export const PROFILED_STATUS_CHUNK_SIZES = [6, 12, 25] as const;

// Fisher-Yates, so no step always runs first against a cold GitHub cache.
function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

interface ProfileStep {
  name: string;
  run(): Promise<unknown>;
}

// The steps of one run besides pullsOnly, which runs first because the
// status steps read the node ids it found.
function buildProfileSteps(
  scope: PullsSearchScope,
  searches: readonly ActivePullsRequest[],
  token: string,
  ids: readonly string[]
): ProfileStep[] {
  const steps: ProfileStep[] = [];
  const involvements =
    scope.involves === 'anyone'
      ? []
      : effectivePullInvolvements(scope.involves);
  if (involvements.length > 1) {
    const split = involvements.flatMap((involvement) =>
      buildActivePullsRequests({ ...scope, involves: [involvement] }).filter(
        (search) => search.alias === 'pulls'
      )
    );
    steps.push({
      name: 'splitInvolvements',
      run: () =>
        Promise.all(
          split.map((search) => sendActivePullsSearch(search, token))
        ),
    });
  }
  for (const search of searches) {
    if (search.alias !== 'pulls') {
      steps.push({
        name: `${search.alias}Only`,
        run: () => sendActivePullsSearch(search, token),
      });
    }
  }
  steps.push({
    name: 'parallelPage',
    run: () =>
      Promise.all(
        searches.map((search) => sendActivePullsSearch(search, token))
      ),
  });
  if (ids.length > 0) {
    for (const size of PROFILED_STATUS_CHUNK_SIZES) {
      steps.push({
        name: `statuses${size}`,
        run: () => readPullStatuses(ids, token, size),
      });
    }
  }
  return steps;
}

// Times each step of the first page one at a time, so they don't compete
// with each other for GitHub or the per-token request queue, and logs the
// results as one line. Errors are recorded per step rather than thrown,
// since this runs after the response has been sent.
export async function profilePullsSearch(
  scope: PullsSearchScope,
  token: string
): Promise<void> {
  const searches = buildActivePullsRequests(scope, undefined);
  const timings: Record<string, number | string> = {};
  const order: string[] = [];
  const time = async (name: string, run: () => Promise<unknown>) => {
    order.push(name);
    const startedAt = Date.now();
    try {
      const result = await run();
      timings[name] = Date.now() - startedAt;
      return result;
    } catch (error) {
      timings[name] =
        `error after ${Date.now() - startedAt}ms: ${formatError(error)}`;
      return null;
    }
  };

  const main = searches.find((search) => search.alias === 'pulls');
  const pullsData =
    main == null
      ? null
      : await time('pullsOnly', () => sendActivePullsSearch(main, token));
  const ids =
    pullsData == null
      ? []
      : parseActivePullsPayload(pullsData).pulls.flatMap((pull) =>
          pull.nodeId == null ? [] : [pull.nodeId]
        );
  for (const step of shuffled(buildProfileSteps(scope, searches, token, ids))) {
    await time(step.name, step.run);
  }
  emitLogLine({
    event: 'github_pulls_profile',
    ids: ids.length,
    level: 'info',
    mutedAuthors: scope.mutedAuthors?.length ?? 0,
    order,
    repos: scope.repos?.length ?? 0,
    searches: searches.map((search) => search.alias),
    timingsMs: timings,
  });
}
