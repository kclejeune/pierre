'use client';

import {
  IconCheck,
  IconCircleFill,
  IconClockArrow,
  IconComment,
  IconMerged,
  IconMinus,
  IconPencil,
  IconX,
} from '@pierre/icons';
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import {
  useAppPermissionBlock,
  useRememberAppRefusal,
} from './AppPermissionsContext';
import { Button } from './Button';
import { ButtonGroup, ButtonGroupItem } from './ButtonGroup';
import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { InlineConfirm } from './InlineConfirm';
import { Input } from './Input';
import { LabelColorDot } from './LabelColorDot';
import { MarkdownContent } from './MarkdownContent';
import { MarkdownEditor } from './MarkdownEditor';
import {
  MergeStatusCard,
  PullOverviewMeta,
  TONE_TEXT_CLASS,
} from './PullOverview';
import { PULL_STATE_DISPLAY } from './pullStateDisplay';
import { useDropdownChromeStyle } from './useDropdownChromeStyle';
import { useRepoLabels } from './useRepoLabels';
import { annotationBorderColor } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import { displayPullState } from '@/lib/githubPullSummaries';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import {
  changePullLabel,
  type PullEditChanges,
  updatePullRequest,
} from '@/lib/pullEditClient';
import {
  fetchPullDetailsSupplement,
  mergePullReviewers,
  type PullCheck,
  type PullDetails,
  type PullDetailsSupplement,
  type PullInfo,
  type PullLabel,
  type PullMergeCapabilities,
  type PullMergeQueueStatus,
  type PullReviewer,
} from '@/lib/pullInfoClient';
import {
  mergePullRequest,
  type MergeQueueAction,
  type PullMergeMethod,
  updateMergeQueue,
} from '@/lib/pullMergeClient';
import {
  type ConversationCounts,
  describeMergeHeadline,
  type OverviewCell,
  plural,
  summarizeApprovals,
  summarizeChecks,
  summarizeConversations,
} from '@/lib/pullOverview';
import { toastError } from '@/lib/toastRequestError';
import type { DiffsHubDiffStats } from '@/lib/types';

interface PullDetailsControlProps {
  // Whether the viewer has a token; merging always needs one.
  canWrite: boolean;
  // Review conversations on the loaded diff, resolved vs total; null until
  // the diff (and so its threads) has loaded.
  conversations: ConversationCounts | null;
  // Line counts of the loaded diff, for the +/− diffstat.
  diffStats: DiffsHubDiffStats | null;
  getGitHubToken(): string | undefined;
  // Bumped on credential changes; permissions are per-viewer, so the
  // supplement reloads.
  githubTokenVersion: number;
  // Merges refreshed fields into the latest details after any edit.
  onDetailsEdited(pull: PullRequestRef, fields: Partial<PullDetails>): void;
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

type SupplementState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; value: PullDetailsSupplement };

export type PullDetailsModel = NonNullable<
  ReturnType<typeof usePullDetailsModel>
>;

// Everything the pull-details panel shows and edits for one pull: the
// lazily loaded supplement (checks, review verdicts, viewer permissions,
// merge options), the cells and headline derived from it, and the panel's
// local edit/expand state. Kept in one hook so the header chip (CI dot,
// unresolved count) and the panel body read the same state, and so the
// /pulls preview pane can show the same panel without the chip. Null until
// the pull's details have loaded.
export function usePullDetailsModel({
  canWrite,
  conversations,
  getGitHubToken,
  githubTokenVersion,
  pullInfo,
  pullRequest,
}: {
  canWrite: boolean;
  conversations: ConversationCounts | null;
  getGitHubToken(): string | undefined;
  githubTokenVersion: number;
  pullInfo: PullInfo | null;
  pullRequest: PullRequestRef;
}) {
  const [checksExpanded, setChecksExpanded] = useState(false);
  // Held here so an edit survives the dropdown closing, which unmounts the
  // form.
  const [editDraft, setEditDraft] = useState<PullEditDraft | null>(null);
  const supplementRequest = useRef<AbortController | null>(null);
  const [supplement, setSupplement] = useState<SupplementState>({
    kind: 'idle',
  });
  // usePullInfo clears state whenever the pull changes, so a non-null
  // pullInfo always belongs to this pullRequest.
  const details = pullInfo?.details;
  const headSha = pullInfo?.headSha;

  useEffect(() => {
    setEditDraft(null);
    setChecksExpanded(false);
  }, [pullRequest.number, pullRequest.owner, pullRequest.repo]);

  useEffect(() => {
    supplementRequest.current?.abort();
    supplementRequest.current = null;
    setSupplement({ kind: 'idle' });
    return () => supplementRequest.current?.abort();
  }, [
    githubTokenVersion,
    headSha,
    pullRequest.number,
    pullRequest.owner,
    pullRequest.repo,
  ]);

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

  // Load eagerly whenever nothing is loaded for the current head: the first
  // render (so the trigger's CI dot can appear without opening the panel),
  // and the reset to idle after a head-sha change (so an already-open panel
  // does not sit on its loading placeholders forever).
  useEffect(() => {
    if (headSha != null && supplement.kind === 'idle') {
      loadSupplement();
    }
  }, [headSha, loadSupplement, supplement.kind]);

  if (details == null) {
    return null;
  }
  const supplementalValue =
    supplement.kind === 'ready' ? supplement.value : null;
  const checks = supplementalValue?.checks ?? null;
  // Verdicts are unknown, not absent, when the whole supplement request
  // failed or it reported reviewers: null (the reviews listing itself
  // failed), so the panel says so instead of presenting everyone as merely
  // pending.
  const reviewerVerdictsUnavailable =
    supplement.kind === 'error' ||
    (supplementalValue != null && supplementalValue.reviewers == null);
  const reviewers = mergePullReviewers(
    details.reviewers,
    supplementalValue?.reviewers ?? null
  );
  const permissions = canWrite ? supplementalValue?.viewerPermissions : null;
  const canEdit = permissions?.canUpdate === true;
  const supplementLoading =
    supplement.kind === 'idle' || supplement.kind === 'loading';
  const checksMetric = checks == null ? null : summarizeChecks(checks);
  // The trigger's CI dot: the checks tone, hidden when every check was
  // skipped or none ran.
  const ciState =
    checksMetric?.tone === 'neutral' ? null : (checksMetric?.tone ?? null);
  const checksCell: OverviewCell = supplementLoading
    ? { kind: 'loading' }
    : supplement.kind === 'error'
      ? { kind: 'unavailable', reason: supplement.message }
      : (checksMetric ?? {
          kind: 'unavailable',
          reason: 'CI status could not be loaded.',
        });
  const approvalsCell: OverviewCell = supplementLoading
    ? { kind: 'loading' }
    : reviewerVerdictsUnavailable
      ? { kind: 'unavailable', reason: 'Review verdicts could not be loaded.' }
      : summarizeApprovals(reviewers);
  const commentsCell: OverviewCell =
    conversations == null
      ? { kind: 'loading' }
      : summarizeConversations(conversations);
  const headline = describeMergeHeadline({
    checks: checksCell,
    details,
    reviewers: approvalsCell,
  });
  return {
    approvalsCell,
    canEdit,
    checks,
    checksCell,
    checksExpanded,
    ciState,
    commentsCell,
    details,
    editDraft,
    headSha,
    headline,
    loadSupplement,
    permissions,
    reviewerVerdictsUnavailable,
    reviewers,
    setChecksExpanded,
    setEditDraft,
    setSupplement,
    showMergeControls: details.state === 'open' && canWrite,
    // Draft, close, and reopen share the merge controls' sticky footer.
    showStateActions: canEdit && details.state !== 'merged',
    supplement,
    supplementLoading,
    supplementalValue,
    // Unresolved review conversations, the one overview number worth
    // showing on the closed chip: it is what a reviewer acts on next. Only
    // known once resolution has loaded (`counted`).
    unresolvedCount:
      conversations?.kind === 'counted'
        ? Math.max(0, conversations.total - conversations.resolved)
        : 0,
  };
}

// The header's pull-details control: a compact state chip (draft/open/merged
// plus an aggregate CI dot) opening the pull's overview in a popover (see
// PullDetailsPanel).
export function PullDetailsControl({
  canWrite,
  conversations,
  diffStats,
  getGitHubToken,
  githubTokenVersion,
  onDetailsEdited,
  onMerged,
  pullInfo,
  pullRequest,
}: PullDetailsControlProps) {
  const dropdownThemeStyle = useDropdownChromeStyle();
  const [open, setOpen] = useState(false);
  const model = usePullDetailsModel({
    canWrite,
    conversations,
    getGitHubToken,
    githubTokenVersion,
    pullInfo,
    pullRequest,
  });
  if (model == null) {
    return null;
  }
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={`#${pullRequest.number} ${model.details.title}`}
          aria-label={`Pull request details: ${model.details.title}`}
          className={cn(
            CHROME_ICON_BUTTON_CLASS,
            'w-auto max-w-80 min-w-0 gap-1.5 px-2'
          )}
        >
          <PullStateBadge details={model.details} iconOnly />
          {/* The title truncates harder as the header narrows and drops out
              below lg, where the URL beside the chip already names the pull
              and the state icon carries it. */}
          <span className="min-w-0 truncate max-lg:hidden lg:max-w-[18ch] xl:max-w-none">
            {model.details.title}
          </span>
          {model.editDraft != null && (
            <IconPencil
              aria-label="Unsaved edits"
              className="size-3 shrink-0 text-amber-500"
            />
          )}
          {model.ciState != null && (
            <IconCircleFill
              aria-label={`Checks ${model.ciState}`}
              className={cn('size-2', TONE_TEXT_CLASS[model.ciState])}
            />
          )}
          {model.unresolvedCount > 0 && (
            <span
              aria-label={plural(
                model.unresolvedCount,
                'unresolved conversation',
                'unresolved conversations'
              )}
              className="text-muted-foreground flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums"
            >
              <IconComment aria-hidden className="size-3" />
              {model.unresolvedCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // No padding on the scroller itself (see PullPreviewPane): the
        // panel's sticky footer would otherwise stop short of the bottom.
        className="max-h-[min(85vh,60rem)] w-[560px] max-w-[92vw] overflow-y-auto p-0 md:w-[720px]"
        style={dropdownThemeStyle}
      >
        <div className="p-3">
          <PullDetailsPanel
            diffStats={diffStats}
            footerSurfaceClassName="bg-[var(--diffshub-popover-bg,var(--color-popover))]"
            getGitHubToken={getGitHubToken}
            model={model}
            pullInfo={pullInfo}
            pullRequest={pullRequest}
            onDetailsEdited={onDetailsEdited}
            onMerged={() => {
              setOpen(false);
              onMerged();
            }}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The pull's overview, laid out after GitHub's PR overview: title,
// author/branches/diffstat line, a merge-status card (headline, Checks /
// Comments / Approvals bars), labels, reviewers with their verdicts, and the
// description, with the merge and close/reopen/draft actions in a footer
// pinned to the bottom of the scrolling container. Also hosts the
// title/description editor. Expects a parent with 0.75rem (p-3) padding,
// which the footer spans with negative margins; `footerSurfaceClassName` is
// that parent's background so the footer hides what scrolls under it.
export function PullDetailsPanel({
  diffStats,
  footerSurfaceClassName,
  getGitHubToken,
  model,
  onDetailsEdited,
  onMerged,
  pullInfo,
  pullRequest,
}: {
  diffStats: DiffsHubDiffStats | null;
  footerSurfaceClassName: string;
  getGitHubToken(): string | undefined;
  model: PullDetailsModel;
  onDetailsEdited(pull: PullRequestRef, fields: Partial<PullDetails>): void;
  onMerged(): void;
  pullInfo: PullInfo | null;
  pullRequest: PullRequestRef;
}) {
  // Without Checks: Read, GitHub withholds check runs and only commit
  // statuses come back, so the list is partial; say so under it.
  const checkRunsBlocked = useAppPermissionBlock('checkRuns');
  const checkRunsNote = checkRunsBlocked != null && (
    <p className="text-muted-foreground mt-1 text-xs">
      Check runs aren&apos;t shown. {checkRunsBlocked}
    </p>
  );
  const editing = model.editDraft != null;
  return (
    // A size container: once the panel is wider than 48rem (the /pulls
    // preview on large screens; never the 720px popover), labels and
    // reviewers move into a sidebar beside the description, as on GitHub's
    // PR page, instead of stretching across the full width.
    <div className="@container flex flex-col gap-3">
      {model.editDraft != null ? (
        <PullEditForm
          details={model.details}
          draft={model.editDraft}
          getGitHubToken={getGitHubToken}
          onCancel={() => model.setEditDraft(null)}
          onDraftChange={model.setEditDraft}
          onSaved={(updated) => {
            model.setEditDraft(null);
            onDetailsEdited(pullRequest, withoutLabels(updated));
          }}
          pullRequest={pullRequest}
        />
      ) : (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 text-sm font-medium">
            {model.details.title}
            <span className="text-muted-foreground font-normal">
              {' '}
              #{pullRequest.number}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-1">
            {model.canEdit && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Edit title and description"
                aria-label="Edit title and description"
                onClick={() =>
                  model.setEditDraft({
                    body: model.details.body,
                    title: model.details.title,
                  })
                }
              >
                <IconPencil className="size-3.5" />
              </Button>
            )}
            <PullStateBadge details={model.details} />
          </span>
        </div>
      )}
      <PullOverviewMeta
        details={model.details}
        diffStats={diffStats}
        pullInfo={pullInfo}
      />
      <MergeStatusCard
        approvals={model.approvalsCell}
        checks={model.checksCell}
        checksDetail={
          model.checks != null && model.checks.length > 0 ? (
            <>
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {model.checks.map((check, index) => (
                  <CheckRow key={`${check.name}-${index}`} check={check} />
                ))}
              </ul>
              {checkRunsNote}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <p
                  className={cn(
                    'text-xs',
                    model.supplement.kind === 'error'
                      ? 'text-destructive'
                      : 'text-muted-foreground',
                    model.checksCell.kind === 'loading' && 'animate-pulse'
                  )}
                >
                  {model.checksCell.kind === 'unavailable'
                    ? model.checksCell.reason
                    : model.checksCell.kind === 'loading'
                      ? 'Loading checks…'
                      : 'No checks reported on the head commit.'}
                </p>
                {model.supplement.kind === 'error' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => model.loadSupplement(true)}
                  >
                    Retry
                  </Button>
                )}
              </div>
              {checkRunsNote}
            </>
          )
        }
        checksExpanded={model.checksExpanded}
        comments={model.commentsCell}
        headline={model.headline}
        onToggleChecks={() => model.setChecksExpanded((current) => !current)}
      />
      <div
        className={cn(
          'flex flex-col gap-3',
          !editing &&
            '@3xl:grid @3xl:grid-cols-[minmax(0,1fr)_17rem] @3xl:items-start @3xl:gap-x-6'
        )}
      >
        <div className="flex min-w-0 flex-col gap-3 @3xl:col-start-2 @3xl:row-start-1">
          <PullLabels
            key={`${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`}
            canEdit={model.permissions?.canLabel === true}
            getGitHubToken={getGitHubToken}
            labels={model.details.labels}
            onLabelsChanged={(labels) =>
              onDetailsEdited(pullRequest, { labels })
            }
            pullRequest={pullRequest}
          />
          {(model.reviewers.length > 0 ||
            model.reviewerVerdictsUnavailable) && (
            <PanelSection heading="Reviewers">
              {model.reviewers.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {model.reviewers.map((reviewer) => (
                    <ReviewerRow key={reviewer.login} reviewer={reviewer} />
                  ))}
                </ul>
              )}
              {model.reviewerVerdictsUnavailable && (
                <p className="text-muted-foreground text-xs">
                  Review verdicts could not be loaded; showing requested
                  reviewers only.
                </p>
              )}
            </PanelSection>
          )}
        </div>
        {!editing && (
          <div className="min-w-0 @3xl:col-start-1 @3xl:row-start-1">
            <PanelSection heading="Description">
              {model.details.body.trim() === '' ? (
                <p className="text-muted-foreground text-xs">
                  No description provided.
                </p>
              ) : (
                <div
                  className={`rounded-md border ${annotationBorderColor} px-3 py-2 text-[13px]`}
                >
                  <MarkdownContent
                    flavor="comment"
                    markdown={model.details.body}
                  />
                </div>
              )}
            </PanelSection>
          </div>
        )}
      </div>
      {(model.showMergeControls || model.showStateActions) && (
        // Pinned to the panel's bottom edge so the actions stay in reach
        // while a long description scrolls; -mx/-mb span the panel's
        // padding, and the surface background hides what scrolls under.
        <div
          className={cn(
            'sticky bottom-0 -mx-3 -mb-3 flex flex-col gap-2 border-t px-3 py-2.5',
            annotationBorderColor,
            footerSurfaceClassName
          )}
        >
          {model.showMergeControls && (
            <MergeCapabilitySection
              baseRef={pullInfo?.baseRef}
              capabilities={model.supplementalValue?.mergeCapabilities ?? null}
              details={model.details}
              getGitHubToken={getGitHubToken}
              headSha={model.headSha}
              loading={model.supplementLoading}
              mergeQueue={model.supplementalValue?.mergeQueue ?? null}
              // Applies only to the supplement the action started from: if
              // it reloaded meanwhile (say, a push moved the head), the
              // late response describes an old head and is dropped.
              onMergeQueueChange={(mergeQueue) =>
                model.setSupplement((current) =>
                  current.kind === 'ready' &&
                  current.value === model.supplementalValue
                    ? {
                        ...current,
                        value: { ...current.value, mergeQueue },
                      }
                    : current
                )
              }
              onMerged={() => {
                // Marks the pull merged right away; the reloads that
                // follow confirm it.
                onDetailsEdited(pullRequest, { state: 'merged' });
                onMerged();
              }}
              pullRequest={pullRequest}
            />
          )}
          {model.showStateActions && (
            <PullStateActions
              details={model.details}
              getGitHubToken={getGitHubToken}
              onUpdated={(updated) =>
                onDetailsEdited(pullRequest, withoutLabels(updated))
              }
              pullRequest={pullRequest}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MergeCapabilitySection({
  capabilities,
  loading,
  mergeQueue,
  onMergeQueueChange,
  ...controls
}: {
  capabilities: PullMergeCapabilities | null;
  loading: boolean;
  mergeQueue: PullMergeQueueStatus | null;
  onMergeQueueChange(status: PullMergeQueueStatus | null): void;
} & Omit<ComponentProps<typeof MergeControls>, 'capabilities'>) {
  if (loading) {
    return (
      <p className="text-muted-foreground text-xs">
        Checking merge permissions…
      </p>
    );
  }
  if (capabilities == null) {
    return (
      <p className="text-muted-foreground text-xs">
        Merge permissions could not be loaded. Open this pull request on GitHub
        to merge it.
      </p>
    );
  }
  if (!capabilities.canMerge) {
    return (
      <p className="text-muted-foreground text-xs">
        Your GitHub token does not have permission to merge this pull request.
      </p>
    );
  }
  if (mergeQueue != null) {
    const { baseRef, details, getGitHubToken, headSha, pullRequest } = controls;
    return (
      <MergeQueueControls
        baseRef={baseRef}
        details={details}
        getGitHubToken={getGitHubToken}
        headSha={headSha}
        onStatusChange={onMergeQueueChange}
        pullRequest={pullRequest}
        status={mergeQueue}
      />
    );
  }
  if (capabilities.methods.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        This repository does not expose a direct merge method. Use GitHub for
        repository-specific merge rules.
      </p>
    );
  }
  return <MergeControls {...controls} capabilities={capabilities} />;
}

interface PullEditDraft {
  body: string;
  title: string;
}

// Sends only changed fields so concurrent edits on GitHub survive. Keys stay
// Sends only changed fields so concurrent edits on GitHub survive. Keydowns
// stay in the fields (no Radix typeahead); Escape cancels, asking first if
// dirty.
function PullEditForm({
  details,
  draft,
  getGitHubToken,
  onCancel,
  onDraftChange,
  onSaved,
  pullRequest,
}: {
  details: PullDetails;
  draft: PullEditDraft;
  getGitHubToken(): string | undefined;
  onCancel(): void;
  onDraftChange(draft: PullEditDraft): void;
  onSaved(details: PullDetails): void;
  pullRequest: PullRequestRef;
}) {
  const { body, title } = draft;
  const [isSaving, setIsSaving] = useState(false);
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false);
  const trimmedTitle = title.trim();
  const isDirty = trimmedTitle !== details.title || body !== details.body;
  const canSave = !isSaving && trimmedTitle !== '';

  async function save() {
    const changes: PullEditChanges = {
      ...(trimmedTitle !== details.title ? { title: trimmedTitle } : {}),
      ...(body !== details.body ? { body } : {}),
    };
    const token = getGitHubToken();
    if (!canSave || token == null || token === '') {
      return;
    }
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }
    setIsSaving(true);
    try {
      onSaved(await updatePullRequest(pullRequest, token, changes));
      toast.success('Pull request updated.');
    } catch (error) {
      toastError(error, 'Updating the pull request failed.');
    } finally {
      setIsSaving(false);
    }
  }

  function requestCancel() {
    if (isSaving) {
      return;
    }
    if (isDirty) {
      setIsConfirmingDiscard(true);
    } else {
      onCancel();
    }
  }

  function handleKeyDown(keyEvent: KeyboardEvent) {
    keyEvent.stopPropagation();
    if (keyEvent.key === 'Escape') {
      keyEvent.preventDefault();
      requestCancel();
    } else if (
      keyEvent.key === 'Enter' &&
      (keyEvent.metaKey || keyEvent.ctrlKey)
    ) {
      keyEvent.preventDefault();
      void save();
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(formEvent) => {
        formEvent.preventDefault();
        void save();
      }}
    >
      <Input
        inputSize="sm"
        value={title}
        disabled={isSaving}
        aria-label="Pull request title"
        placeholder="Title"
        autoFocus
        aria-invalid={trimmedTitle === ''}
        onChange={({ currentTarget }) =>
          onDraftChange({ ...draft, title: currentTarget.value })
        }
        onKeyDown={handleKeyDown}
      />
      <MarkdownEditor
        aria-label="Pull request description"
        disabled={isSaving}
        placeholder="Add a description…"
        rows={8}
        textareaClassName="max-h-80 min-h-32 font-mono text-[12px]"
        value={body}
        onCancel={requestCancel}
        onChange={(next) => onDraftChange({ ...draft, body: next })}
        onKeyDown={(keyEvent) => keyEvent.stopPropagation()}
        onSubmit={() => void save()}
      />
      {isConfirmingDiscard ? (
        <InlineConfirm
          confirmLabel="Discard"
          message="Discard your edits?"
          onCancel={() => setIsConfirmingDiscard(false)}
          onConfirm={onCancel}
        />
      ) : (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={isSaving}
            onClick={requestCancel}
          >
            Cancel
          </Button>
          <Button type="submit" variant="default" size="xs" disabled={!canSave}>
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </form>
  );
}

// Closing asks first because it notifies participants. Draft toggles only apply
// to open pulls.
function PullStateActions({
  details,
  getGitHubToken,
  onUpdated,
  pullRequest,
}: {
  details: PullDetails;
  getGitHubToken(): string | undefined;
  onUpdated(details: PullDetails): void;
  pullRequest: PullRequestRef;
}) {
  const [pending, setPending] = useState<'draft' | 'state' | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const draftBlocked = useAppPermissionBlock('draft');
  const rememberRefusal = useRememberAppRefusal();

  async function apply(
    kind: 'draft' | 'state',
    changes: PullEditChanges,
    success: string
  ) {
    const token = getGitHubToken();
    if (token == null || token === '' || pending != null) {
      return;
    }
    setPending(kind);
    try {
      onUpdated(await updatePullRequest(pullRequest, token, changes));
      toast.success(success);
    } catch (error) {
      toastError(error, 'Updating the pull request failed.');
      if (kind === 'draft') {
        rememberRefusal('draft', error);
      }
    } finally {
      setPending(null);
    }
  }

  const isOpen = details.state === 'open';
  const toggleState = () =>
    void apply(
      'state',
      { state: isOpen ? 'closed' : 'open' },
      isOpen ? 'Pull request closed.' : 'Pull request reopened.'
    );
  if (confirmingClose) {
    return (
      <InlineConfirm
        confirmLabel="Close pull request"
        disabled={pending != null}
        message={`Close #${pullRequest.number} without merging?`}
        onCancel={() => setConfirmingClose(false)}
        onConfirm={() => {
          setConfirmingClose(false);
          toggleState();
        }}
      />
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {isOpen && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          blockedReason={draftBlocked}
          disabled={pending != null}
          onClick={() =>
            void apply(
              'draft',
              { draft: !details.draft },
              details.draft ? 'Marked ready for review.' : 'Converted to draft.'
            )
          }
        >
          {pending === 'draft'
            ? 'Updating…'
            : details.draft
              ? 'Ready for review'
              : 'Convert to draft'}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={pending != null}
        className={isOpen ? 'text-red-500' : undefined}
        onClick={() => (isOpen ? setConfirmingClose(true) : toggleState())}
      >
        {pending === 'state'
          ? 'Updating…'
          : isOpen
            ? 'Close pull request'
            : 'Reopen pull request'}
      </Button>
    </div>
  );
}

// One add/remove request per click, so others' concurrent label changes
// survive.
function PullLabels({
  canEdit,
  getGitHubToken,
  labels,
  onLabelsChanged,
  pullRequest,
}: {
  canEdit: boolean;
  getGitHubToken(): string | undefined;
  labels: PullLabel[];
  onLabelsChanged(labels: PullLabel[]): void;
  pullRequest: PullRequestRef;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const repoLabels = useRepoLabels(pickerOpen ? pullRequest : null);

  if (labels.length === 0 && !canEdit) {
    return null;
  }

  async function toggle(label: string, action: 'add' | 'remove') {
    const token = getGitHubToken();
    if (token == null || token === '' || pendingLabel != null) {
      return;
    }
    setPendingLabel(label);
    try {
      onLabelsChanged(await changePullLabel(pullRequest, token, action, label));
    } catch (error) {
      toastError(error, 'Updating labels failed.');
    } finally {
      setPendingLabel(null);
    }
  }

  const applied = new Set(labels.map((label) => label.name));
  const query = filter.trim().toLowerCase();
  const matches =
    repoLabels?.kind === 'ready'
      ? repoLabels.labels.filter((label) =>
          label.name.toLowerCase().includes(query)
        )
      : [];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {labels.map((label) => (
          <span
            key={label.name}
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium"
          >
            <LabelColorDot color={label.color} />
            {label.name}
            {canEdit && (
              <button
                type="button"
                aria-label={`Remove label ${label.name}`}
                disabled={pendingLabel != null}
                className="text-muted-foreground hover:text-foreground -mr-1 disabled:opacity-50"
                onClick={() => void toggle(label.name, 'remove')}
              >
                <IconX className="size-3" />
              </button>
            )}
          </span>
        ))}
        {canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            {pickerOpen ? 'Done' : labels.length === 0 ? 'Add labels' : 'Edit'}
          </Button>
        )}
      </div>
      {pickerOpen && (
        <div
          className={`flex flex-col gap-1 rounded-md border ${annotationBorderColor} p-1.5`}
        >
          <Input
            inputSize="sm"
            value={filter}
            placeholder="Filter labels"
            aria-label="Filter labels"
            autoFocus
            onChange={({ currentTarget }) => setFilter(currentTarget.value)}
            // Block Radix typeahead. Enter toggles the top match.
            onKeyDown={(keyEvent) => {
              keyEvent.stopPropagation();
              const top = matches[0];
              if (keyEvent.key === 'Enter' && query !== '' && top != null) {
                keyEvent.preventDefault();
                void toggle(top.name, applied.has(top.name) ? 'remove' : 'add');
                setFilter('');
              }
            }}
          />
          {repoLabels == null ? (
            <p className="text-muted-foreground animate-pulse px-1 text-xs">
              Loading labels…
            </p>
          ) : repoLabels.kind === 'error' ? (
            <p className="text-destructive px-1 text-xs">
              {repoLabels.message}
            </p>
          ) : matches.length === 0 ? (
            <p className="text-muted-foreground px-1 text-xs">
              {query === ''
                ? 'This repository has no labels.'
                : `No labels match “${filter.trim()}”.`}
            </p>
          ) : (
            <ul className="flex max-h-40 flex-col overflow-y-auto">
              {matches.map((label) => {
                const isApplied = applied.has(label.name);
                return (
                  <li key={label.name}>
                    <button
                      type="button"
                      disabled={pendingLabel != null}
                      className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))] disabled:opacity-50"
                      onClick={() =>
                        void toggle(label.name, isApplied ? 'remove' : 'add')
                      }
                    >
                      <IconCheck
                        aria-hidden
                        className={cn(
                          'size-3 shrink-0',
                          !isApplied && 'invisible'
                        )}
                      />
                      <LabelColorDot color={label.color} />
                      <span className="min-w-0 flex-1 truncate">
                        {label.name}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Label requests own `labels`; edit responses apply everything else, so an
// edit that finishes after a label change cannot restore the older labels.
function withoutLabels({
  labels: _labels,
  ...fields
}: PullDetails): Partial<PullDetails> {
  return fields;
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
  const { className, Icon, label } =
    PULL_STATE_DISPLAY[displayPullState(details.state, details.draft)];
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
      className={cn('size-3.5 shrink-0', TONE_TEXT_CLASS[state])}
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
      ? {
          className: TONE_TEXT_CLASS.success,
          Icon: IconCheck,
          label: 'Approved',
        }
      : reviewer.state === 'CHANGES_REQUESTED'
        ? {
            className: TONE_TEXT_CLASS.failure,
            Icon: IconX,
            label: 'Changes requested',
          }
        : reviewer.state === 'COMMENTED'
          ? {
              className: TONE_TEXT_CLASS.neutral,
              Icon: IconMinus,
              label: 'Commented',
            }
          : {
              className: TONE_TEXT_CLASS.pending,
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

// Why the pull can't be merged or queued now, or null when nothing blocks it.
function useMergeBlockedReason(details: PullDetails): string | null {
  const appBlocked = useAppPermissionBlock('merge');
  if (details.draft) {
    return 'Draft pull requests cannot be merged.';
  }
  if (details.mergeable === false) {
    return 'This pull request has conflicts with its base branch.';
  }
  return appBlocked;
}

// Runs a merge or merge-queue request with the viewer's token, one at a time:
// `busy` is true while it's in flight, and a failure is toasted (and
// remembered when GitHub refused the app) instead of thrown.
function useMergeAction(getGitHubToken: () => string | undefined): {
  busy: boolean;
  run(
    request: (token: string) => Promise<void>,
    failureMessage: string
  ): Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const rememberRefusal = useRememberAppRefusal();
  async function run(
    request: (token: string) => Promise<void>,
    failureMessage: string
  ) {
    const token = getGitHubToken();
    if (token == null || token === '' || busy) {
      return;
    }
    setBusy(true);
    try {
      await request(token);
    } catch (error) {
      toastError(error, failureMessage);
      rememberRefusal('merge', error);
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

function BaseBranchLabel({ baseRef }: { baseRef: string | undefined }) {
  return baseRef == null ? (
    'the base branch'
  ) : (
    <span className="font-mono">{baseRef}</span>
  );
}

const QUEUE_ENTRY_STATE_LABELS: Readonly<Record<string, string>> = {
  AWAITING_CHECKS: 'waiting on checks',
  LOCKED: 'merging',
  MERGEABLE: 'ready to merge',
  QUEUED: 'queued',
  UNMERGEABLE: 'failed checks or conflicts; GitHub will remove it',
};

// The success toast for a queue action, given where the pull stands after it.
function describeQueueChange(
  action: MergeQueueAction,
  status: PullMergeQueueStatus | null
): string {
  if (action !== 'enqueue') {
    return 'Removed from the merge queue.';
  }
  if (status?.entry != null) {
    return `Added to the merge queue at position ${status.entry.position}.`;
  }
  return 'Will join the merge queue once required checks pass.';
}

// The merge affordance for a base branch with a merge queue, where the queue
// picks the method: "Merge when ready" queues the pull (now, or once required
// checks pass), and a queued or pending pull can be taken back out. Renders
// the panel's loaded status and reports each action's result through
// onStatusChange, so reopening the panel shows it too.
function MergeQueueControls({
  baseRef,
  details,
  getGitHubToken,
  headSha,
  onStatusChange,
  pullRequest,
  status,
}: {
  baseRef: string | undefined;
  details: PullDetails;
  getGitHubToken(): string | undefined;
  headSha: string | undefined;
  onStatusChange(status: PullMergeQueueStatus | null): void;
  pullRequest: PullRequestRef;
  status: PullMergeQueueStatus;
}) {
  const blockedReason = useMergeBlockedReason(details);
  const { busy, run } = useMergeAction(getGitHubToken);
  const queueAction = (action: MergeQueueAction) =>
    void run(async (token) => {
      const next = await updateMergeQueue(pullRequest, token, action, headSha);
      onStatusChange(next);
      toast.success(describeQueueChange(action, next));
    }, 'Updating the merge queue failed.');

  const { entry } = status;
  if (entry != null || status.pendingAutoMerge) {
    return (
      <div className="flex items-center justify-between gap-2 text-xs">
        <span>
          {entry != null ? (
            <>
              #{entry.position} in the <BaseBranchLabel baseRef={baseRef} />{' '}
              merge queue (
              {QUEUE_ENTRY_STATE_LABELS[entry.state] ??
                entry.state.toLowerCase()}
              ).
            </>
          ) : (
            <>
              Joins the <BaseBranchLabel baseRef={baseRef} /> merge queue once
              required checks pass.
            </>
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() =>
            queueAction(entry != null ? 'dequeue' : 'cancel-auto-merge')
          }
        >
          {entry != null ? 'Remove from queue' : 'Cancel'}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          <BaseBranchLabel baseRef={baseRef} /> merges through a merge queue.
        </span>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={blockedReason != null || busy}
          className="bg-emerald-600 hover:bg-emerald-700"
          onClick={() => queueAction('enqueue')}
        >
          <IconMerged className="size-3.5" />
          {busy ? 'Queueing…' : 'Merge when ready'}
        </Button>
      </div>
      {blockedReason != null && (
        <p className="text-muted-foreground text-xs">{blockedReason}</p>
      )}
    </div>
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
  const blockedReason = useMergeBlockedReason(details);
  const { busy: isMerging, run } = useMergeAction(getGitHubToken);

  function submit() {
    void run(async (token) => {
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
          toast.error(
            result.message ?? 'GitHub did not merge the pull request.'
          );
        }
      } finally {
        setConfirming(false);
      }
    }, 'Merging the pull request failed.');
  }
  return (
    <div className="flex flex-col gap-2">
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
            <BaseBranchLabel baseRef={baseRef} />?
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
              onClick={submit}
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
