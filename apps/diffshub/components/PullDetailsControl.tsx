'use client';

import {
  IconCheck,
  IconCircleFill,
  IconClockArrow,
  IconDraft,
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

import { Button } from './Button';
import { ButtonGroup, ButtonGroupItem } from './ButtonGroup';
import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { Input } from './Input';
import { MarkdownContent } from './MarkdownContent';
import { useDropdownChromeStyle } from './useDropdownChromeStyle';
import { useRepoLabels } from './useRepoLabels';
import { cn } from '@/lib/cn';
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
  type PullReviewer,
} from '@/lib/pullInfoClient';
import { mergePullRequest, type PullMergeMethod } from '@/lib/pullMergeClient';
import { toastError } from '@/lib/toastRequestError';

interface PullDetailsControlProps {
  // Whether the viewer has a token; merging always needs one.
  canWrite: boolean;
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

// The header's pull-details control: a compact state chip (draft/open/merged
// plus an aggregate CI dot) opening a panel with the pull's title,
// description, labels, reviewers with their review verdicts, per-check CI
// status, and — for writable open pulls — the merge button. Also hosts the
// edit, close/reopen, draft, and label controls.
export function PullDetailsControl({
  canWrite,
  getGitHubToken,
  githubTokenVersion,
  onDetailsEdited,
  onMerged,
  pullInfo,
  pullRequest,
}: PullDetailsControlProps) {
  const dropdownThemeStyle = useDropdownChromeStyle();
  const [open, setOpen] = useState(false);
  const [merged, setMerged] = useState(false);
  const [editing, setEditing] = useState(false);
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
    setMerged(false);
    setEditing(false);
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
  // The supplement reports reviewers: null when the reviews listing itself
  // failed — the verdicts are unknown, not absent, so the panel says so
  // instead of presenting everyone as merely pending.
  const reviewerVerdictsUnavailable =
    supplementalValue != null && supplementalValue.reviewers == null;
  const reviewers = mergePullReviewers(
    details.reviewers,
    supplementalValue?.reviewers ?? null
  );
  const ciState = aggregateCheckState(checks);
  const permissions = canWrite ? supplementalValue?.viewerPermissions : null;
  const canEdit = permissions?.canUpdate === true;
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
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
          {editing ? (
            <PullEditForm
              details={details}
              getGitHubToken={getGitHubToken}
              onCancel={() => setEditing(false)}
              onSaved={(updated) => {
                setEditing(false);
                onDetailsEdited(pullRequest, withoutLabels(updated));
              }}
              pullRequest={pullRequest}
            />
          ) : (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 text-sm font-medium">
                {details.title}
                <span className="text-muted-foreground font-normal">
                  {' '}
                  #{pullRequest.number}
                </span>
              </div>
              <span className="flex shrink-0 items-center gap-1">
                {canEdit && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Edit title and description"
                    aria-label="Edit title and description"
                    onClick={() => setEditing(true)}
                  >
                    <IconPencil className="size-3.5" />
                  </Button>
                )}
                <PullStateBadge details={details} />
              </span>
            </div>
          )}
          <PullLabels
            key={`${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`}
            canEdit={permissions?.canLabel === true}
            getGitHubToken={getGitHubToken}
            labels={details.labels}
            onLabelsChanged={(labels) =>
              onDetailsEdited(pullRequest, { labels })
            }
            pullRequest={pullRequest}
          />
          {(reviewers.length > 0 || reviewerVerdictsUnavailable) && (
            <PanelSection heading="Reviewers">
              {reviewers.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {reviewers.map((reviewer) => (
                    <ReviewerRow key={reviewer.login} reviewer={reviewer} />
                  ))}
                </ul>
              )}
              {reviewerVerdictsUnavailable && (
                <p className="text-muted-foreground text-xs">
                  Review verdicts could not be loaded; showing requested
                  reviewers only.
                </p>
              )}
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
          {!editing && (
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
          )}
          {canEdit && details.state !== 'merged' && !merged && (
            <PullStateActions
              details={details}
              getGitHubToken={getGitHubToken}
              onUpdated={(updated) =>
                onDetailsEdited(pullRequest, withoutLabels(updated))
              }
              pullRequest={pullRequest}
            />
          )}
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

// Sends only changed fields so concurrent edits on GitHub survive. Keys stay
// in the fields so Radix typeahead and Escape-to-close don't steal them.
function PullEditForm({
  details,
  getGitHubToken,
  onCancel,
  onSaved,
  pullRequest,
}: {
  details: PullDetails;
  getGitHubToken(): string | undefined;
  onCancel(): void;
  onSaved(details: PullDetails): void;
  pullRequest: PullRequestRef;
}) {
  const [title, setTitle] = useState(details.title);
  const [body, setBody] = useState(details.body);
  const [isSaving, setIsSaving] = useState(false);
  const trimmedTitle = title.trim();
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

  function handleKeyDown(keyEvent: KeyboardEvent) {
    keyEvent.stopPropagation();
    if (keyEvent.key === 'Escape') {
      keyEvent.preventDefault();
      if (!isSaving) {
        onCancel();
      }
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
        onChange={({ currentTarget }) => setTitle(currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <textarea
        value={body}
        rows={8}
        disabled={isSaving}
        aria-label="Pull request description"
        placeholder="Add a description… (markdown)"
        className="field-sizing-content max-h-80 min-h-32 w-full resize-none rounded-md border border-[var(--diffshub-annotation-border,var(--color-border))] bg-transparent px-3 py-1.5 font-mono text-[12px] text-inherit placeholder:text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] focus:outline-none"
        onChange={({ currentTarget }) => setBody(currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={isSaving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" variant="default" size="xs" disabled={!canSave}>
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

// Reversible, so no confirm step. GitHub only allows draft toggles on open
// pulls.
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
    } finally {
      setPending(null);
    }
  }

  const isOpen = details.state === 'open';
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-[var(--diffshub-annotation-border,var(--color-border))] pt-3">
      {isOpen && (
        <Button
          type="button"
          variant="outline"
          size="xs"
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
        onClick={() =>
          void apply(
            'state',
            { state: isOpen ? 'closed' : 'open' },
            isOpen ? 'Pull request closed.' : 'Pull request reopened.'
          )
        }
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
        <div className="flex flex-col gap-1 rounded-md border border-[var(--diffshub-annotation-border,var(--color-border))] p-1.5">
          <Input
            inputSize="sm"
            value={filter}
            placeholder="Filter labels"
            aria-label="Filter labels"
            autoFocus
            onChange={({ currentTarget }) => setFilter(currentTarget.value)}
            // Block Radix menu typeahead.
            onKeyDown={(keyEvent) => keyEvent.stopPropagation()}
          />
          {repoLabels == null ? (
            <p className="text-muted-foreground animate-pulse px-1 text-xs">
              Loading labels…
            </p>
          ) : repoLabels.kind === 'error' ? (
            <p className="text-destructive px-1 text-xs">
              {repoLabels.message}
            </p>
          ) : (
            <ul className="flex max-h-40 flex-col overflow-y-auto">
              {repoLabels.labels
                .filter((label) => label.name.toLowerCase().includes(query))
                .map((label) => {
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

// GitHub colors are bare 6-digit hex. A dot, rather than tinted text, stays
// readable on any chrome theme.
function LabelColorDot({ color }: { color: string }) {
  if (!/^[0-9a-fA-F]{6}$/.test(color)) {
    return null;
  }
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: `#${color}` }}
    />
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
