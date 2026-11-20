'use client';

import { IconCheck, IconClockArrow, IconMinus, IconX } from '@pierre/icons';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import {
  PanelEmptyLine,
  PanelPicker,
  PanelPickerOption,
  PanelPickerToggle,
  usePanelPicker,
} from './PanelPicker';
import { PanelSection } from './PanelSection';
import { TONE_TEXT_CLASS } from './PullOverview';
import { useReviewerCandidates } from './useReviewerCandidates';
import { cn } from '@/lib/cn';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import { changePullReviewer } from '@/lib/pullEditClient';
import type { PullReviewer, PullReviewerState } from '@/lib/pullInfoClient';

// What the panel knows about submitted reviews: still loading (the details
// supplement), loaded, or failed (only the requested reviewers are known).
export type ReviewerVerdicts = 'loading' | 'ready' | 'unavailable';

// The details panel's Reviewers section: everyone requested or who has
// reviewed, with their verdicts, plus (for viewers with triage access or
// above) a picker to request a user's review and a remove button on each
// pending user request. Teams are listed but can't be changed here. Always
// rendered, with a fixed-height line while empty, so the panel keeps its
// layout as the supplement and permissions load.
export function PullReviewers({
  authorLogin,
  canEdit,
  getGitHubToken,
  onRequestedChanged,
  pullRequest,
  requested,
  reviewers,
  verdicts,
}: {
  // The pull's author, left out of the picker (GitHub refuses to request a
  // review from them).
  authorLogin: string | undefined;
  // 'loading' while the viewer's permissions are still unknown.
  canEdit: boolean | 'loading';
  getGitHubToken(): string | undefined;
  // The pending requests (users and teams) after a change.
  onRequestedChanged(requested: PullReviewer[]): void;
  pullRequest: PullRequestRef;
  // The pending requests as the pull reports them (PullDetails.reviewers).
  requested: readonly PullReviewer[];
  // `requested` merged with submitted verdicts (mergePullReviewers).
  reviewers: readonly PullReviewer[];
  verdicts: ReviewerVerdicts;
}) {
  const picker = usePanelPicker(getGitHubToken);
  const editable = canEdit === true;
  const candidates = useReviewerCandidates(
    picker.open && editable ? pullRequest : null,
    picker.filter
  );
  // Pending user requests: the ones the remove button and the picker's
  // check marks apply to.
  const requestedUsers = new Set(
    requested
      .filter((reviewer) => reviewer.team !== true)
      .map((reviewer) => reviewer.login.toLowerCase())
  );
  const isRequested = (login: string) =>
    requestedUsers.has(login.toLowerCase());

  const change = (login: string, action: 'add' | 'remove') =>
    void picker.run(
      login,
      async (token) =>
        onRequestedChanged(
          await changePullReviewer(pullRequest, token, action, login)
        ),
      action === 'add'
        ? `Requesting a review from ${login} failed.`
        : `Removing ${login}'s review request failed.`
    );
  const toggle = (login: string) =>
    change(login, isRequested(login) ? 'remove' : 'add');
  const isRemovable = (reviewer: PullReviewer) =>
    editable && reviewer.team !== true && isRequested(reviewer.login);
  const reserveRemoveSlot = reviewers.some(isRemovable);

  const empty = reviewers.length === 0;
  const pickerToggle = editable ? (
    <PanelPickerToggle
      addLabel="Request reviewers"
      addText="Request"
      empty={empty}
      open={picker.open}
      onToggle={picker.toggle}
    />
  ) : null;
  const matches =
    candidates?.kind === 'ready'
      ? candidates.candidates.filter(
          (candidate) =>
            candidate.login.toLowerCase() !== authorLogin?.toLowerCase()
        )
      : [];
  const query = picker.filter.trim();

  return (
    <PanelSection
      action={!empty && pickerToggle}
      heading="Reviewers"
      inline={empty && !picker.open && verdicts !== 'unavailable'}
    >
      {empty ? (
        <PanelEmptyLine
          emptyText="No reviewers requested."
          loading={verdicts === 'loading' || canEdit === 'loading'}
          loadingText="Loading reviewers…"
          toggle={pickerToggle}
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {reviewers.map((reviewer) => (
            <ReviewerRow
              key={`${reviewer.team === true ? 'team' : 'user'}:${reviewer.login}`}
              busy={picker.pending != null}
              reserveRemoveSlot={reserveRemoveSlot}
              reviewer={reviewer}
              onRemove={
                isRemovable(reviewer)
                  ? () => change(reviewer.login, 'remove')
                  : undefined
              }
            />
          ))}
        </ul>
      )}
      {verdicts === 'unavailable' && (
        <p className="text-muted-foreground text-xs">
          Review verdicts could not be loaded; showing requested reviewers only.
        </p>
      )}
      {picker.open && editable && (
        <PanelPicker
          ariaLabel="Search people to request a review from"
          filter={picker.filter}
          message={
            candidates == null
              ? { kind: 'loading', text: 'Searching…' }
              : candidates.kind === 'error'
                ? { kind: 'error', text: candidates.message }
                : matches.length === 0
                  ? {
                      kind: 'note',
                      text:
                        query === ''
                          ? 'No one else can be requested in this repository.'
                          : `No one matches “${query}”.`,
                    }
                  : null
          }
          placeholder="Search people"
          onEnter={() => {
            // Nothing to pick while the search is settling or loading; the
            // text stays so that search still runs.
            const top = matches[0];
            if (top == null) {
              return false;
            }
            toggle(top.login);
            return true;
          }}
          onFilterChange={picker.setFilter}
        >
          {matches.map((candidate) => (
            <PanelPickerOption
              key={candidate.login}
              checked={isRequested(candidate.login)}
              disabled={picker.pending != null}
              onSelect={() => toggle(candidate.login)}
            >
              <CommentAuthorAvatar
                author={{
                  avatarUrl: candidate.avatarUrl ?? '',
                  login: candidate.login,
                }}
                className="size-4"
                lookupProfile={false}
              />
              <span className="min-w-0 flex-1 truncate">
                {candidate.login}
                {candidate.name != null && (
                  <span className="text-muted-foreground">
                    {' '}
                    {candidate.name}
                  </span>
                )}
              </span>
            </PanelPickerOption>
          ))}
        </PanelPicker>
      )}
    </PanelSection>
  );
}

// How each review state reads in the list.
const VERDICTS: Record<
  PullReviewerState,
  { className: string; Icon: typeof IconCheck; label: string }
> = {
  APPROVED: {
    className: TONE_TEXT_CLASS.success,
    Icon: IconCheck,
    label: 'Approved',
  },
  CHANGES_REQUESTED: {
    className: TONE_TEXT_CLASS.failure,
    Icon: IconX,
    label: 'Changes requested',
  },
  COMMENTED: {
    className: TONE_TEXT_CLASS.neutral,
    Icon: IconMinus,
    label: 'Commented',
  },
  PENDING: {
    className: TONE_TEXT_CLASS.pending,
    Icon: IconClockArrow,
    label: 'Review pending',
  },
};

// One reviewer: avatar, login, and their verdict, plus a remove button when
// `onRemove` is set (a pending user request the viewer may withdraw).
// `reserveRemoveSlot` (set when any row is removable) keeps an empty slot of
// the button's size on rows without one, such as team requests, so the
// verdicts line up in one column.
function ReviewerRow({
  busy,
  onRemove,
  reserveRemoveSlot,
  reviewer,
}: {
  busy: boolean;
  onRemove?(): void;
  reserveRemoveSlot: boolean;
  reviewer: PullReviewer;
}) {
  const verdict = VERDICTS[reviewer.state];
  return (
    <li className="flex min-h-5.5 items-center gap-2">
      <CommentAuthorAvatar
        author={{ avatarUrl: reviewer.avatarUrl ?? '', login: reviewer.login }}
        className="size-5 self-center"
        lookupProfile={reviewer.team !== true}
      />
      <span className="min-w-0 flex-1 truncate text-xs">{reviewer.login}</span>
      <span
        className={cn('flex items-center gap-1 text-[11px]', verdict.className)}
      >
        <verdict.Icon className="size-3" />
        {verdict.label}
      </span>
      {onRemove != null ? (
        <button
          type="button"
          aria-label={`Remove ${reviewer.login}'s review request`}
          title="Remove review request"
          disabled={busy}
          className="text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-50"
          onClick={onRemove}
        >
          <IconX className="size-3" />
        </button>
      ) : (
        reserveRemoveSlot && <span aria-hidden className="size-3 shrink-0" />
      )}
    </li>
  );
}
