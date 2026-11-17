import type { PullCheck, PullDetails, PullReviewer } from './pullInfoClient';

// The pull overview's status vocabulary, shared by the progress bars, their
// summaries, and the headline icon.
export type OverviewTone = 'failure' | 'neutral' | 'pending' | 'success';

export interface OverviewSegment {
  count: number;
  tone: OverviewTone;
}

// One cell of the merge-status card (Checks, Comments, Approvals): a short
// summary plus the segments its progress bar draws. Empty segments mean the
// bar renders as the hatched "nothing here" placeholder.
export interface OverviewMetric {
  segments: OverviewSegment[];
  summary: string;
  tone: OverviewTone | null;
  // How many items carry `tone` (e.g. failing checks), for headline copy.
  toneCount: number;
}

// A metric still loading, or one GitHub could not report (e.g. the reviews
// listing failed), shown in its cell instead of a summary and bar.
export type OverviewCell =
  | OverviewMetric
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string };

export function isOverviewMetric(cell: OverviewCell): cell is OverviewMetric {
  return !('kind' in cell);
}

// Starts a metric from its bar segments (dropping empty ones); the returned
// function finishes it with whichever summary the caller's branch picks.
function metricFrom(segments: OverviewSegment[]) {
  const nonEmpty = segments.filter((segment) => segment.count > 0);
  return (
    summary: string,
    tone: OverviewTone | null = null,
    toneCount = 0
  ): OverviewMetric => ({ segments: nonEmpty, summary, tone, toneCount });
}

// Checks cell: failing beats pending beats passing; the header trigger's CI
// dot shows the same tone.
export function summarizeChecks(checks: readonly PullCheck[]): OverviewMetric {
  const counts = { failure: 0, neutral: 0, pending: 0, success: 0 };
  for (const check of checks) {
    counts[check.state] += 1;
  }
  const metric = metricFrom([
    { count: counts.success, tone: 'success' },
    { count: counts.failure, tone: 'failure' },
    { count: counts.pending, tone: 'pending' },
    { count: counts.neutral, tone: 'neutral' },
  ]);
  if (checks.length === 0) {
    return metric('None reported');
  }
  if (counts.failure > 0) {
    return metric(`${counts.failure} failing`, 'failure', counts.failure);
  }
  if (counts.pending > 0) {
    return metric(`${counts.pending} pending`, 'pending', counts.pending);
  }
  if (counts.success > 0) {
    return metric(`${counts.success} passed`, 'success', counts.success);
  }
  return metric(`${counts.neutral} skipped`, 'neutral', counts.neutral);
}

// What the viewer knows about the pull's review conversations: `counted`
// when thread resolution loaded, `totalOnly` when it could not be read (no
// token, or the GraphQL request failed), and `unavailable` when the review
// comments themselves failed to load.
export type ConversationCounts =
  | { kind: 'counted'; resolved: number; total: number }
  | { kind: 'totalOnly'; total: number }
  | { kind: 'unavailable' };

// Comments cell: review conversations on the diff, resolved vs open. Without
// resolution data it reports the total in a neutral tone rather than calling
// every conversation unresolved.
export function summarizeConversations(
  counts: ConversationCounts
): OverviewCell {
  if (counts.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: 'Review comments could not be loaded.',
    };
  }
  if (counts.kind === 'totalOnly') {
    const metric = metricFrom([{ count: counts.total, tone: 'neutral' }]);
    if (counts.total === 0) {
      return metric('No conversations');
    }
    return metric(
      counts.total === 1 ? '1 conversation' : `${counts.total} conversations`,
      'neutral',
      counts.total
    );
  }
  const { resolved, total } = counts;
  const unresolved = Math.max(0, total - resolved);
  const metric = metricFrom([
    { count: resolved, tone: 'success' },
    { count: unresolved, tone: 'pending' },
  ]);
  if (total === 0) {
    return metric('No conversations');
  }
  if (unresolved > 0) {
    return metric(`${unresolved} unresolved`, 'pending', unresolved);
  }
  return metric('All resolved', 'success', resolved);
}

// Approvals cell: one segment per reviewer verdict. A requested change wins
// the summary, since it blocks merging regardless of other approvals.
export function summarizeApprovals(
  reviewers: readonly PullReviewer[]
): OverviewMetric {
  let approved = 0;
  let changesRequested = 0;
  for (const reviewer of reviewers) {
    if (reviewer.state === 'APPROVED') {
      approved += 1;
    } else if (reviewer.state === 'CHANGES_REQUESTED') {
      changesRequested += 1;
    }
  }
  const waiting = reviewers.length - approved - changesRequested;
  const metric = metricFrom([
    { count: approved, tone: 'success' },
    { count: changesRequested, tone: 'failure' },
    { count: waiting, tone: 'neutral' },
  ]);
  if (reviewers.length === 0) {
    return metric('No reviewers');
  }
  if (changesRequested > 0) {
    return metric('Changes requested', 'failure', changesRequested);
  }
  if (approved > 0) {
    return metric(
      `${approved} of ${reviewers.length} approved`,
      'success',
      approved
    );
  }
  return metric(`${waiting} awaiting review`, 'pending', waiting);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface OverviewHeadline {
  detail: string;
  title: string;
  tone: OverviewTone | 'closed' | 'merged';
}

// The merge-status card's headline: the single most important thing standing
// between this pull and a merge, in roughly GitHub's priority order. Takes
// the same cells the card shows, so a loading cell never yields "ready" and
// an unavailable one says the status is incomplete instead of waiting.
export function describeMergeHeadline({
  checks: checksCell,
  details,
  reviewers: reviewersCell,
}: {
  checks: OverviewCell;
  details: PullDetails;
  reviewers: OverviewCell;
}): OverviewHeadline {
  const checks = isOverviewMetric(checksCell) ? checksCell : null;
  const reviewers = isOverviewMetric(reviewersCell) ? reviewersCell : null;
  if (details.state === 'merged') {
    return {
      detail: 'The changes were merged into the base branch.',
      title: 'Merged',
      tone: 'merged',
    };
  }
  if (details.state === 'closed') {
    return {
      detail: 'This pull request was closed without merging.',
      title: 'Closed',
      tone: 'closed',
    };
  }
  if (details.draft) {
    return {
      detail: 'This pull request is still a work in progress.',
      title: 'Draft',
      tone: 'neutral',
    };
  }
  if (details.mergeable === false || details.mergeableState === 'dirty') {
    return {
      detail: 'Resolve the conflicts with the base branch before merging.',
      title: 'This branch has conflicts',
      tone: 'failure',
    };
  }
  if (checks?.tone === 'failure') {
    return {
      detail: plural(checks.toneCount, 'check', 'checks') + ' failed.',
      title: 'Some checks were not successful',
      tone: 'failure',
    };
  }
  if (reviewers?.tone === 'failure') {
    return {
      detail: 'A reviewer asked for changes before this can merge.',
      title: 'Changes requested',
      tone: 'failure',
    };
  }
  if (details.mergeableState === 'behind') {
    return {
      detail: 'Update your branch with the base branch before merging.',
      title: 'Required to update',
      tone: 'pending',
    };
  }
  if (checks?.tone === 'pending') {
    return {
      detail: `${plural(checks.toneCount, 'check is', 'checks are')} still running or queued.`,
      title: 'Checks in progress',
      tone: 'pending',
    };
  }
  if (details.mergeableState === 'blocked') {
    return {
      detail: 'Required reviews or status checks have not passed yet.',
      title: 'Merging is blocked',
      tone: 'pending',
    };
  }
  const cells = [checksCell, reviewersCell];
  if (
    details.mergeable == null ||
    cells.some((cell) => !isOverviewMetric(cell) && cell.kind === 'loading')
  ) {
    return {
      detail: 'Waiting on GitHub for checks and mergeability.',
      title: 'Checking merge status',
      tone: 'pending',
    };
  }
  if (checks == null || reviewers == null) {
    return {
      detail: 'GitHub did not report every check or review; confirm on GitHub.',
      title: 'Merge status incomplete',
      tone: 'neutral',
    };
  }
  return {
    detail: 'No conflicts with the base branch.',
    title: 'Ready to merge',
    tone: 'success',
  };
}

const DIFFSTAT_BLOCK_COUNT = 5;

// GitHub's five-square diffstat: squares split between additions and
// deletions in proportion, each side getting at least one square when it is
// non-zero. No changes renders all squares neutral.
export function diffstatBlocks(
  added: number,
  deleted: number
): ('added' | 'deleted' | 'neutral')[] {
  const total = added + deleted;
  if (total === 0) {
    return Array.from({ length: DIFFSTAT_BLOCK_COUNT }, () => 'neutral');
  }
  let addedBlocks = Math.round((added / total) * DIFFSTAT_BLOCK_COUNT);
  if (added > 0) {
    addedBlocks = Math.max(1, addedBlocks);
  }
  if (deleted > 0) {
    addedBlocks = Math.min(DIFFSTAT_BLOCK_COUNT - 1, addedBlocks);
  }
  return Array.from({ length: DIFFSTAT_BLOCK_COUNT }, (_, index) =>
    index < addedBlocks ? 'added' : 'deleted'
  );
}
