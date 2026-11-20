'use client';

import { IconCheckbox, IconCheckCircle, IconMerged } from '@pierre/icons';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from './Button';
import { readStoredGitHubToken } from './githubSession';
import { PULL_STATE_DISPLAY } from './pullStateDisplay';
import { Spinner } from './Spinner';
import { useLatestValueRef } from './useLatestValueRef';
import { cn } from '@/lib/cn';
import { pullKey, type PullSummary } from '@/lib/githubPullSummaries';
import {
  type PullBatchAction,
  type PullBatchResult,
  runPullBatch,
} from '@/lib/pullBatchActions';
import { plural } from '@/lib/pullOverview';

const ACTION_COPY: Record<PullBatchAction, { done: string; running: string }> =
  {
    approve: { done: 'Approved', running: 'Approving' },
    merge: { done: 'Merged or queued', running: 'Merging' },
  };

// Where a batch came from: the checked rows (the batch bar), or one row's
// action menu, whose failure isn't carried back into the selection.
export type PullBatchOrigin = 'row' | 'selection';

// Toasts a finished batch: one success line, plus the first few failures
// with GitHub's reasons (own pulls can't be approved, a branch moved, checks
// are required, ...). A single row's action names its pull instead.
function reportBatch(
  action: PullBatchAction,
  result: PullBatchResult,
  origin: PullBatchOrigin,
  pulls: readonly PullSummary[]
) {
  const { failures, succeeded } = result;
  if (origin === 'row') {
    const failure = failures[0];
    if (failure == null) {
      toast.success(`${ACTION_COPY[action].done} ${pullKey(pulls[0])}.`);
    } else {
      toast.error(`${pullKey(failure.pull)}: ${failure.message}`);
    }
    return;
  }
  if (failures.length === 0) {
    toast.success(
      `${ACTION_COPY[action].done} ${plural(succeeded, 'pull request', 'pull requests')}.`
    );
    return;
  }
  const shown = failures
    .slice(0, 3)
    .map(({ message, pull }) => `${pullKey(pull)}: ${message}`);
  if (failures.length > shown.length) {
    shown.push(`and ${failures.length - shown.length} more`);
  }
  toast.error(
    `${failures.length} of ${succeeded + failures.length} failed; they stay selected.`,
    { description: shown.join('; ') }
  );
}

// A batch in flight: its action, how many pulls it covers, and how many have
// settled.
export interface PullBatchProgress {
  action: PullBatchAction;
  done: number;
  total: number;
}

// Runs approve/merge batches for the /pulls list. Owned by the list rather
// than the batch bar, so a batch keeps its progress (and the list keeps its
// selection locked) however the bar mounts and unmounts while it runs; and
// a second batch can't start until the first settles. `onFinished` gets
// what ran and where it came from, the pulls it failed on, and whether
// anything changed (so the list refetches).
export interface PullBatchOutcome {
  action: PullBatchAction;
  changed: boolean;
  failed: PullSummary[];
  origin: PullBatchOrigin;
}

export function usePullBatch(onFinished: (outcome: PullBatchOutcome) => void): {
  running: PullBatchProgress | null;
  run(
    action: PullBatchAction,
    pulls: readonly PullSummary[],
    origin?: PullBatchOrigin,
    expectedHeadSha?: string
  ): void;
} {
  const [running, setRunning] = useState<PullBatchProgress | null>(null);
  // Set synchronously, so two clicks in one frame can't both start a batch.
  const busy = useRef(false);
  const finished = useLatestValueRef(onFinished);

  const run = (
    action: PullBatchAction,
    pulls: readonly PullSummary[],
    origin: PullBatchOrigin = 'selection',
    expectedHeadSha?: string
  ) => {
    if (busy.current || pulls.length === 0) {
      return;
    }
    const token = readStoredGitHubToken();
    if (token === '') {
      toast.error('Sign in to GitHub to approve or merge pull requests.');
      return;
    }
    busy.current = true;
    const total = pulls.length;
    setRunning({ action, done: 0, total });
    void runPullBatch(
      pulls,
      action,
      token,
      (done) => setRunning({ action, done, total }),
      expectedHeadSha
    )
      .then((result) => {
        reportBatch(action, result, origin, pulls);
        finished.current({
          action,
          changed: result.succeeded > 0,
          failed: result.failures.map((failure) => failure.pull),
          origin,
        });
      })
      .finally(() => {
        busy.current = false;
        setRunning(null);
      });
  };

  return { running, run };
}

// The strip that replaces the list header's filters while rows are checked
// or a batch runs: how many, select every loaded row, approve, merge (with a
// confirm step, since merging can't be undone), and clear. While a batch
// runs it shows progress instead of actions.
export function PullBatchBar({
  allLoadedChecked,
  checked,
  loadedCount,
  onClear,
  onRun,
  onSelectAll,
  running,
}: {
  allLoadedChecked: boolean;
  checked: readonly PullSummary[];
  loadedCount: number;
  onClear(): void;
  onRun(action: PullBatchAction): void;
  onSelectAll(): void;
  running: PullBatchProgress | null;
}) {
  // The selection the merge confirm was armed for, as its pull keys. Merging
  // can't be undone, so any change to the selection (a shift-click, Select
  // all) disarms the confirm rather than carrying it over to pulls the
  // viewer never confirmed.
  const selectionKey = checked.map(pullKey).join(' ');
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmingMerge = confirmedFor === selectionKey;
  const run = (action: PullBatchAction) => {
    setConfirmedFor(null);
    onRun(action);
  };

  const count = checked.length;
  return (
    <div
      role="toolbar"
      aria-label="Selected pull requests"
      // Wraps like the list toolbar it replaces: the count and Select all
      // on the left, the actions on the right, and on a narrow list the
      // actions drop to their own line as a group, left-aligned
      // (space-between puts a line's lone item at the start).
      className="flex min-h-7 flex-1 flex-wrap items-center justify-between gap-2 text-xs"
    >
      <div className="flex items-center gap-1.5">
        {/* px-1.5 matches the state tab this bar replaces, so the text
            doesn't jump sideways when a row is checked. */}
        <span className="text-foreground px-1.5 font-medium tabular-nums">
          {running == null ? `${count} selected` : `${running.total} in batch`}
        </span>
        {!allLoadedChecked && running == null && (
          <Button
            size="toolbar"
            variant="outline"
            className="px-2"
            onClick={onSelectAll}
          >
            <IconCheckbox className="size-3.5" />
            Select all {loadedCount}
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {running != null ? (
          <span className="text-muted-foreground flex items-center gap-1.5 tabular-nums">
            <Spinner className="size-3" />
            {ACTION_COPY[running.action].running} {running.done}/{running.total}
            …
          </span>
        ) : (
          <>
            <Button
              size="toolbar"
              variant="outline"
              className="px-2"
              onClick={() => run('approve')}
            >
              {/* The row menu's glyphs for the same actions. The buttons
                  stay neutral: the green belongs to the merge confirm, the
                  step that actually merges. */}
              <IconCheckCircle className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              Approve
            </Button>
            {confirmingMerge ? (
              <Button
                size="toolbar"
                variant="success"
                className="px-2"
                onClick={() => run('merge')}
              >
                <IconMerged className="size-3.5" />
                Confirm merge of {count}
              </Button>
            ) : (
              <Button
                size="toolbar"
                variant="outline"
                className="px-2"
                title="Join the merge queue where there is one, otherwise merge with the repository's default method"
                onClick={() => setConfirmedFor(selectionKey)}
              >
                <IconMerged
                  className={cn(
                    'size-3.5',
                    PULL_STATE_DISPLAY.merged.className
                  )}
                />
                Merge when ready
              </Button>
            )}
            <Button
              size="toolbar"
              variant="ghost"
              className="px-2"
              onClick={onClear}
            >
              Clear
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
