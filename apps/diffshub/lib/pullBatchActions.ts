// Approve or merge several /pulls rows at once: the batch bar's actions for
// clearing out bot pulls (dependency bumps, owners-file syncs) that need a
// rubber stamp. Each pull is handled the way its details panel would, pinned
// to the head commit read just before acting, so a branch that moves
// mid-batch fails that pull instead of approving or merging unseen commits.

import type { PullSummary } from './githubPullSummaries';
import type { PullRequestRef } from './pullCommentsClient';
import { submitPullReview } from './pullCommentsClient';
import { fetchPullDetailsSupplement, fetchPullInfo } from './pullInfoClient';
import { mergePullRequest, updateMergeQueue } from './pullMergeClient';
import { planPullMerge, pullMergeBlockedReason } from './pullMergePlan';

export type PullBatchAction = 'approve' | 'merge';

interface PullBatchFailure {
  pull: PullSummary;
  message: string;
}

export interface PullBatchResult {
  failures: PullBatchFailure[];
  succeeded: number;
}

// GitHub rate-limits bursts of writes; a few at a time stays well clear and
// still finishes a page of bot pulls in seconds.
const BATCH_CONCURRENCY = 3;

function toRef(pull: PullSummary): PullRequestRef {
  return { number: String(pull.number), owner: pull.owner, repo: pull.repo };
}

// The pull as GitHub has it now. 'no-store': the head must be current, not
// the browser's cached copy.
function readPull(ref: PullRequestRef, token: string) {
  return fetchPullInfo(ref, token, undefined, 'no-store');
}

async function approvePull(ref: PullRequestRef, token: string): Promise<void> {
  const { headSha } = await readPull(ref, token);
  await submitPullReview(ref, token, 'APPROVE', '', [], headSha);
}

// "Merge when ready", decided by the same plan as the details panel's merge
// footer (lib/pullMergePlan): join the merge queue where the base branch has
// one, otherwise merge with the repository's default method.
async function mergePull(ref: PullRequestRef, token: string): Promise<void> {
  const { details, headSha } = await readPull(ref, token);
  const blocked = details == null ? null : pullMergeBlockedReason(details);
  if (blocked != null) {
    throw new Error(blocked);
  }
  const supplement = await fetchPullDetailsSupplement(
    ref,
    headSha,
    token,
    undefined,
    { accessOnly: true }
  );
  const plan = planPullMerge(
    supplement.mergeCapabilities,
    supplement.mergeQueue
  );
  if (plan.kind === 'blocked') {
    throw new Error(plan.message);
  }
  if (plan.kind === 'queue') {
    // Already queued, or set to auto-merge (GitHub queues it once checks
    // pass): it's on track to merge, and enqueuing again would only fail.
    const queue = supplement.mergeQueue;
    if (queue?.entry != null || queue?.pendingAutoMerge === true) {
      return;
    }
    await updateMergeQueue(ref, token, 'enqueue', headSha);
    return;
  }
  const result = await mergePullRequest(ref, token, plan.method, headSha);
  if (!result.merged) {
    throw new Error(result.message ?? 'GitHub did not merge it.');
  }
}

const ACTIONS: Record<
  PullBatchAction,
  (ref: PullRequestRef, token: string) => Promise<void>
> = { approve: approvePull, merge: mergePull };

// Runs `action` on every pull, BATCH_CONCURRENCY at a time, collecting
// per-pull failures rather than stopping at the first. `onSettled` fires as
// each pull finishes, for a progress count.
export async function runPullBatch(
  pulls: readonly PullSummary[],
  action: PullBatchAction,
  token: string,
  onSettled?: (done: number) => void
): Promise<PullBatchResult> {
  const run = ACTIONS[action];
  const failures: PullBatchFailure[] = [];
  let succeeded = 0;
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < pulls.length) {
      const pull = pulls[next++];
      try {
        await run(toRef(pull), token);
        succeeded++;
      } catch (error) {
        failures.push({
          pull,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      onSettled?.(++done);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, pulls.length) }, worker)
  );
  return { failures, succeeded };
}
