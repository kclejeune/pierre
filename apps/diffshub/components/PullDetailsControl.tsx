'use client';

import {
  IconCheck,
  IconCircleFill,
  IconClockArrow,
  IconDraft,
  IconMerged,
  IconMinus,
  IconX,
} from '@pierre/icons';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { Button } from './Button';
import { ButtonGroup, ButtonGroupItem } from './ButtonGroup';
import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { MarkdownContent } from './MarkdownContent';
import { useDropdownChromeStyle } from './useDropdownChromeStyle';
import { cn } from '@/lib/cn';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import {
  fetchPullDetailsSupplement,
  mergePullReviewers,
  type PullCheck,
  type PullDetails,
  type PullDetailsSupplement,
  type PullInfo,
  type PullMergeCapabilities,
  type PullReviewer,
} from '@/lib/pullInfoClient';
import { mergePullRequest, type PullMergeMethod } from '@/lib/pullMergeClient';

interface PullDetailsControlProps {
  // Whether the viewer has a token; merging always needs one.
  canWrite: boolean;
  getGitHubToken(): string | undefined;
  // Called after a successful merge so the parent reloads the (now-merged)
  // diff.
  onMerged(): void;
  pullInfo: PullInfo | null;
  pullRequest: PullRequestRef;
}

const MERGE_METHOD_LABELS: Record<PullMergeMethod, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  squash: 'Squash',
};

// The header's pull-details control: a compact state chip (draft/open/merged
// plus an aggregate CI dot) opening a panel with the pull's title,
// description, labels, reviewers with their review verdicts, per-check CI
// status, and — for writable open pulls — the merge button.
export function PullDetailsControl({
  canWrite,
  getGitHubToken,
  onMerged,
  pullInfo,
  pullRequest,
}: PullDetailsControlProps) {
  const dropdownThemeStyle = useDropdownChromeStyle();
  const [open, setOpen] = useState(false);
  const [merged, setMerged] = useState(false);
  const supplementRequest = useRef<AbortController | null>(null);
  const [supplement, setSupplement] = useState<
    | { kind: 'idle' | 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; value: PullDetailsSupplement }
  >({ kind: 'idle' });
  // usePullInfo clears state whenever the pull changes, so a non-null
  // pullInfo always belongs to this pullRequest.
  const details = pullInfo?.details;
  const headSha = pullInfo?.headSha;

  useEffect(() => {
    supplementRequest.current?.abort();
    supplementRequest.current = null;
    setMerged(false);
    setSupplement({ kind: 'idle' });
    return () => supplementRequest.current?.abort();
  }, [headSha, pullRequest.number, pullRequest.owner, pullRequest.repo]);

  const loadSupplement = useCallback(
    (force = false) => {
      if (
        headSha == null ||
        (!force && supplement.kind !== 'idle') ||
        supplement.kind === 'loading'
      ) {
        return;
      }
      supplementRequest.current?.abort();
      const controller = new AbortController();
      supplementRequest.current = controller;
      setSupplement({ kind: 'loading' });
      void fetchPullDetailsSupplement(
        pullRequest,
        headSha,
        getGitHubToken(),
        controller.signal
      ).then(
        (value) => {
          if (!controller.signal.aborted) {
            supplementRequest.current = null;
            setSupplement({ kind: 'ready', value });
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            supplementRequest.current = null;
            setSupplement({
              kind: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : 'Loading pull request details failed.',
            });
          }
        }
      );
    },
    [getGitHubToken, headSha, pullRequest, supplement.kind]
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        loadSupplement();
      }
    },
    [loadSupplement]
  );

  if (details == null) {
    return null;
  }
  const supplementalValue =
    supplement.kind === 'ready' ? supplement.value : null;
  const checks = supplementalValue?.checks ?? details.checks;
  const reviewers = mergePullReviewers(
    details.reviewers,
    supplementalValue?.reviewers ?? null
  );
  const ciState = aggregateCheckState(checks);
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title="Pull request details"
          className={cn(CHROME_ICON_BUTTON_CLASS, 'w-auto gap-1.5 px-2')}
        >
          <PullStateBadge details={details} iconOnly />
          Details
          {ciState != null && (
            <IconCircleFill
              aria-label={`Checks ${ciState}`}
              className={cn('size-2', CI_STATE_TEXT_CLASS[ciState])}
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[420px] max-w-[90vw] p-3"
        style={dropdownThemeStyle}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 text-sm font-medium">
              {details.title}
              <span className="text-muted-foreground font-normal">
                {' '}
                #{pullRequest.number}
              </span>
            </div>
            <PullStateBadge details={details} />
          </div>
          {details.labels.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {details.labels.map((label) => (
                <span
                  key={label.name}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium"
                >
                  {/* GitHub label colors are 6-digit hex without '#'. A dot
                      in the label color (instead of tinting the text) stays
                      readable on any chrome theme. */}
                  {/^[0-9a-fA-F]{6}$/.test(label.color) && (
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ backgroundColor: `#${label.color}` }}
                    />
                  )}
                  {label.name}
                </span>
              ))}
            </div>
          )}
          {reviewers.length > 0 && (
            <PanelSection heading="Reviewers">
              <ul className="flex flex-col gap-1">
                {reviewers.map((reviewer) => (
                  <ReviewerRow key={reviewer.login} reviewer={reviewer} />
                ))}
              </ul>
            </PanelSection>
          )}
          <PanelSection heading="Checks">
            {supplement.kind === 'idle' || supplement.kind === 'loading' ? (
              <p className="text-muted-foreground animate-pulse text-xs">
                Loading checks…
              </p>
            ) : supplement.kind === 'error' ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-destructive text-xs">{supplement.message}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => loadSupplement(true)}
                >
                  Retry
                </Button>
              </div>
            ) : checks == null ? (
              <p className="text-muted-foreground text-xs">
                CI status could not be loaded.
              </p>
            ) : checks.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No checks reported on the head commit.
              </p>
            ) : (
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {checks.map((check, index) => (
                  <CheckRow key={`${check.name}-${index}`} check={check} />
                ))}
              </ul>
            )}
          </PanelSection>
          <PanelSection heading="Description">
            {details.body.trim() === '' ? (
              <p className="text-muted-foreground text-xs">
                No description provided.
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-md border border-[var(--diffshub-annotation-border,var(--color-border))] px-3 py-2 text-[13px]">
                <MarkdownContent markdown={details.body} />
              </div>
            )}
          </PanelSection>
          {details.state === 'open' && canWrite && !merged && (
            <MergeCapabilitySection
              baseRef={pullInfo?.baseRef}
              capabilities={supplementalValue?.mergeCapabilities ?? null}
              details={details}
              getGitHubToken={getGitHubToken}
              headSha={headSha}
              loading={
                supplement.kind === 'idle' || supplement.kind === 'loading'
              }
              onMerged={() => {
                setMerged(true);
                setOpen(false);
                onMerged();
              }}
              pullRequest={pullRequest}
            />
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MergeCapabilitySection({
  capabilities,
  loading,
  ...controls
}: {
  capabilities: PullMergeCapabilities | null;
  loading: boolean;
} & Omit<ComponentProps<typeof MergeControls>, 'capabilities'>) {
  if (loading) {
    return (
      <p className="text-muted-foreground border-t pt-3 text-xs">
        Checking merge permissions…
      </p>
    );
  }
  if (capabilities == null) {
    return (
      <p className="text-muted-foreground border-t pt-3 text-xs">
        Merge permissions could not be loaded. Open this pull request on GitHub
        to merge it.
      </p>
    );
  }
  if (!capabilities.canMerge) {
    return (
      <p className="text-muted-foreground border-t pt-3 text-xs">
        Your GitHub token does not have permission to merge this pull request.
      </p>
    );
  }
  if (capabilities.methods.length === 0) {
    return (
      <p className="text-muted-foreground border-t pt-3 text-xs">
        This repository does not expose a direct merge method. Use GitHub for
        merge queues or repository-specific merge rules.
      </p>
    );
  }
  return <MergeControls {...controls} capabilities={capabilities} />;
}

function PanelSection({
  children,
  heading,
}: {
  children: ReactNode;
  heading: string;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-muted-foreground text-xs font-medium">{heading}</h4>
      {children}
    </section>
  );
}

// Draft / Open / Merged / Closed, as the compact chip the trigger shows
// (iconOnly) and the labelled badge inside the panel.
function PullStateBadge({
  details,
  iconOnly = false,
}: {
  details: PullDetails;
  iconOnly?: boolean;
}) {
  const { className, Icon, label } = details.draft
    ? { className: 'text-muted-foreground', Icon: IconDraft, label: 'Draft' }
    : details.state === 'merged'
      ? { className: 'text-purple-500', Icon: IconMerged, label: 'Merged' }
      : details.state === 'closed'
        ? { className: 'text-red-500', Icon: IconX, label: 'Closed' }
        : { className: 'text-[#18a46c]', Icon: IconMerged, label: 'Open' };
  if (iconOnly) {
    return <Icon aria-label={label} className={cn('size-3.5', className)} />;
  }
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium',
        className
      )}
    >
      <Icon className="size-3" />
      {label}
    </span>
  );
}

const CI_STATE_TEXT_CLASS = {
  failure: 'text-red-500',
  neutral: 'text-muted-foreground',
  pending: 'text-amber-500',
  success: 'text-[#18a46c]',
} as const;

// The single dot the trigger shows: failure wins over pending wins over
// success; all-neutral (or no checks) shows nothing.
function aggregateCheckState(
  checks: PullCheck[] | null
): 'failure' | 'pending' | 'success' | null {
  if (checks == null || checks.length === 0) {
    return null;
  }
  if (checks.some((check) => check.state === 'failure')) {
    return 'failure';
  }
  if (checks.some((check) => check.state === 'pending')) {
    return 'pending';
  }
  return checks.some((check) => check.state === 'success') ? 'success' : null;
}

function CheckStateIcon({ state }: { state: PullCheck['state'] }) {
  const Icon =
    state === 'success'
      ? IconCheck
      : state === 'failure'
        ? IconX
        : state === 'pending'
          ? IconClockArrow
          : IconMinus;
  return (
    <Icon
      aria-label={state}
      className={cn('size-3.5 shrink-0', CI_STATE_TEXT_CLASS[state])}
    />
  );
}

function CheckRow({ check }: { check: PullCheck }) {
  const name = (
    <span className="min-w-0 flex-1 truncate text-xs">{check.name}</span>
  );
  return (
    <li className="flex items-center gap-1.5">
      <CheckStateIcon state={check.state} />
      {check.detailsUrl != null ? (
        <a
          href={check.detailsUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="flex min-w-0 flex-1 items-center hover:underline"
        >
          {name}
        </a>
      ) : (
        name
      )}
    </li>
  );
}

function ReviewerRow({ reviewer }: { reviewer: PullReviewer }) {
  const verdict =
    reviewer.state === 'APPROVED'
      ? { className: 'text-[#18a46c]', Icon: IconCheck, label: 'Approved' }
      : reviewer.state === 'CHANGES_REQUESTED'
        ? { className: 'text-red-500', Icon: IconX, label: 'Changes requested' }
        : reviewer.state === 'COMMENTED'
          ? {
              className: 'text-muted-foreground',
              Icon: IconMinus,
              label: 'Commented',
            }
          : {
              className: 'text-amber-500',
              Icon: IconClockArrow,
              label: 'Review pending',
            };
  return (
    <li className="flex items-center gap-2">
      <CommentAuthorAvatar
        author={{ avatarUrl: reviewer.avatarUrl ?? '', login: reviewer.login }}
        className="size-5 self-center"
      />
      <span className="min-w-0 flex-1 truncate text-xs">{reviewer.login}</span>
      <span
        className={cn('flex items-center gap-1 text-[11px]', verdict.className)}
      >
        <verdict.Icon className="size-3" />
        {verdict.label}
      </span>
    </li>
  );
}

// The merge affordance: method picker plus a two-step confirm. The merge is
// pinned to the head sha the viewer loaded, so a branch that moved since
// fails with a stale-head error instead of merging unseen commits.
function MergeControls({
  baseRef,
  capabilities,
  details,
  getGitHubToken,
  headSha,
  onMerged,
  pullRequest,
}: {
  baseRef: string | undefined;
  capabilities: PullMergeCapabilities;
  details: PullDetails;
  getGitHubToken(): string | undefined;
  headSha: string | undefined;
  onMerged(): void;
  pullRequest: PullRequestRef;
}) {
  const [method, setMethod] = useState<PullMergeMethod>(
    capabilities.methods[0] ?? 'merge'
  );
  const [confirming, setConfirming] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const blockedReason = details.draft
    ? 'Draft pull requests cannot be merged.'
    : details.mergeable === false
      ? 'This pull request has conflicts with its base branch.'
      : null;

  async function submit() {
    const token = getGitHubToken();
    if (token == null || token === '' || isMerging) {
      return;
    }
    setIsMerging(true);
    try {
      const result = await mergePullRequest(
        pullRequest,
        token,
        method,
        headSha
      );
      if (result.merged) {
        toast.success('Pull request merged.');
        onMerged();
      } else {
        toast.error(result.message ?? 'GitHub did not merge the pull request.');
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Merging the pull request failed.'
      );
    } finally {
      setIsMerging(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--diffshub-annotation-border,var(--color-border))] pt-3">
      <div className="flex items-center justify-between gap-2">
        <ButtonGroup
          size="sm"
          value={method}
          onValueChange={(value) => setMethod(value as PullMergeMethod)}
        >
          {capabilities.methods.map((value) => (
            <ButtonGroupItem key={value} value={value}>
              {MERGE_METHOD_LABELS[value]}
            </ButtonGroupItem>
          ))}
        </ButtonGroup>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={blockedReason != null || isMerging || confirming}
          className="bg-emerald-600 hover:bg-emerald-700"
          onClick={() => setConfirming(true)}
        >
          <IconMerged className="size-3.5" />
          {isMerging ? 'Merging…' : 'Merge'}
        </Button>
      </div>
      {confirming && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span>
            {MERGE_METHOD_LABELS[method]} #{pullRequest.number} into{' '}
            {baseRef == null ? (
              'the base branch'
            ) : (
              <span className="font-mono">{baseRef}</span>
            )}
            ?
          </span>
          <span className="flex gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={isMerging}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              size="xs"
              disabled={isMerging}
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => void submit()}
            >
              Confirm merge
            </Button>
          </span>
        </div>
      )}
      {blockedReason != null && (
        <p className="text-muted-foreground text-xs">{blockedReason}</p>
      )}
      {details.mergeable == null && blockedReason == null && (
        <p className="text-muted-foreground text-xs">
          GitHub is still computing mergeability; merging may be rejected.
        </p>
      )}
    </div>
  );
}
