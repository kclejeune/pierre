import type { PullRefs } from './githubCommitServer';
import {
  buildHeaders,
  pullParams,
  type PullRequestRef,
  requestJSON,
} from './pullCommentsClient';

// The pull's base/head branches (with their repositories, which differ for
// fork pulls), tagged with the pull number so a stale response for another
// pull is recognizable after navigation.
export type PullInfo = PullRefs & { number: string };

// Client wrapper for /api/pull-info, for chrome that labels what the loaded
// diff compares.
export async function fetchPullInfo(
  pull: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullInfo> {
  const payload = await requestJSON(`/api/pull-info?${pullParams(pull)}`, {
    headers: buildHeaders(token),
    signal,
  });
  return payload as PullInfo;
}
