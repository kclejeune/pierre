'use client';

import { IconCheck, IconChevronSm, IconCircleFill, IconX } from '@pierre/icons';
import Link from 'next/link';
import { memo, type MouseEvent, useEffect, useRef } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { LabelColorDot } from './LabelColorDot';
import { TONE_TEXT_CLASS } from './PullOverview';
import { useQueuedPullPath } from './PullQueueLinkContext';
import { type PullRowAction, PullRowActions } from './PullRowActions';
import { PULL_STATE_DISPLAY } from './pullStateDisplay';
import { RelativeTime } from './RelativeTime';
import { cn } from '@/lib/cn';
import {
  PULL_ACTIVITY_LABELS,
  PULL_REVIEW_DECISION_LABELS,
  type PullActivity,
  type PullChecksSummary,
  pullKey,
  type PullReviewDecision,
  type PullSummary,
} from '@/lib/githubPullSummaries';
import type { PullLabel } from '@/lib/pullInfoClient';

// Chip colors for the viewer's involvement on "active" rows. Pending
// requests and assignments read in amber (waiting on you), verdicts in the
// green/red the pull details reviewer list uses, and plain participation
// stays muted. Labels come from PULL_ACTIVITY_LABELS.
const PENDING = 'border-amber-500/40 text-amber-600 dark:text-amber-400';
const MUTED = 'text-muted-foreground';
const ACTIVITY_CHIP_CLASSES: Record<PullActivity, string> = {
  authored: MUTED,
  'review-requested': PENDING,
  'team-review-requested': MUTED,
  assigned: PENDING,
  approved: 'border-[#18a46c]/40 text-[#18a46c]',
  'changes-requested': 'border-red-500/40 text-red-600 dark:text-red-400',
  reviewed: MUTED,
  commented: MUTED,
};

// Labels shown inline before the rest collapse into a "+N" chip. Bot pulls
// often carry several bookkeeping labels (datasource, manager, update type)
// that would otherwise fill the row; the preview pane lists them all.
const MAX_ROW_LABELS = 2;

// The callbacks take the row's pull (or its key) instead of closing over it,
// so the list can pass the same functions to every row and the memoized row
// re-renders only when its own props change.
interface PullRequestRowProps {
  // Batch selection (the list's checkboxes). The checkbox shows on hover, and
  // on every row once anything is checked (`selecting`).
  checked?: boolean;
  onToggleChecked?(key: string, shiftKey: boolean): void;
  selecting?: boolean;
  // A batch is running on the selection; the checkbox can't change it.
  selectionLocked?: boolean;
  // Indents the row under a group's lead (an expanded near-duplicate group).
  nested?: boolean;
  // A group lead with company: its group's key, size, and whether it's
  // expanded, for the "+N" toggle beside the link. Primitives, not an
  // object, so the memo compares them by value.
  groupExpanded?: boolean;
  groupKey?: string;
  groupSize?: number;
  onToggleGroup?(key: string): void;
  // Following the link to the diff (rather than previewing): records it in
  // recents and the diff view's queue.
  onOpen(pull: PullSummary): void;
  // The author is muted but the list is showing muted pulls: the row dims so
  // people's pulls still stand out.
  muted?: boolean;
  // Whether the row's author is on the muted list (true even when the row
  // isn't dimmed, e.g. while the query names them with author:).
  authorMuted?: boolean;
  // The row's "⋯" actions menu (components/PullRowActions): approve, merge
  // when ready, copy links, and mute, without previewing or checking the
  // row. actionsBusy holds approve and merge while a batch runs; muteFull
  // marks the muted list as full, which disables muting (unmuting still
  // works).
  actionsBusy?: boolean;
  muteFull?: boolean;
  onRowAction?(pull: PullSummary, action: PullRowAction): void;
  // Plain clicks preview the pull instead of navigating when set (the wide
  // /pulls layout); modified clicks still follow the link.
  onPreview?(pull: PullSummary): void;
  // Warms the preview's data for the row the pointer rests on (after
  // HOVER_PREFETCH_DELAY_MS, so sweeping across the list fetches nothing).
  onPrefetch?(pull: PullSummary): void;
  pull: PullSummary;
  // The pull shown in the preview pane.
  selected?: boolean;
  // The row's CI and review state is still loading (components/
  // usePullStatuses): a placeholder holds the CI glyph's place meanwhile.
  statusPending?: boolean;
  // Hide the owner/repo label inside sections already scoped to one repo.
  showRepo?: boolean;
}

// How long the pointer rests on a row before its preview data is
// prefetched: long enough to skip rows the pointer only passes over, which
// includes the rows a slowing cursor lingers on just short of its target.
// Each prefetch is three requests and several GitHub calls.
const HOVER_PREFETCH_DELAY_MS = 250;

// Whether a click asked the browser for something other than a plain
// same-tab navigation (new tab/window, download, middle button).
function isModifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

// One dashboard pull row. The checkbox and group toggle sit beside the link
// rather than inside it, so they never trigger its navigation.
export const PullRequestRow = memo(function PullRequestRow({
  actionsBusy = false,
  authorMuted = false,
  checked = false,
  groupExpanded = false,
  groupKey,
  groupSize = 1,
  muted = false,
  muteFull = false,
  nested = false,
  onOpen,
  onPrefetch,
  onPreview,
  onToggleChecked,
  onRowAction,
  onToggleGroup,
  pull,
  selected = false,
  selecting = false,
  selectionLocked = false,
  showRepo = true,
  statusPending = false,
}: PullRequestRowProps) {
  const href = useQueuedPullPath(pull.viewerPath);
  const stateDisplay = PULL_STATE_DISPLAY[pull.state];
  const StateIcon = stateDisplay.Icon;
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPrefetch = () => {
    if (hoverTimer.current != null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  useEffect(() => cancelPrefetch, []);
  // The previewed row's data is already loaded.
  const schedulePrefetch =
    onPrefetch == null || selected
      ? undefined
      : () => {
          cancelPrefetch();
          hoverTimer.current = setTimeout(() => {
            hoverTimer.current = null;
            onPrefetch(pull);
          }, HOVER_PREFETCH_DELAY_MS);
        };
  return (
    <div
      className={cn(
        // Square corners: rows sit between the list header and footer, and
        // the section card (overflow-hidden) clips any row that does meet
        // its rounded edge.
        'group/row flex items-start border-b transition-colors last:border-b-0',
        selected
          ? // The full accent fill alone marks the row the preview pane
            // shows; hover and checked rows use lighter tints of it.
            'bg-accent'
          : checked
            ? 'bg-accent/40'
            : 'hover:bg-accent/60',
        muted && !selected && 'opacity-60',
        nested && 'pl-6'
      )}
    >
      {onToggleChecked != null && (
        <input
          type="checkbox"
          aria-label={`Select ${pull.title}`}
          checked={checked}
          disabled={selectionLocked}
          className={cn(
            'accent-foreground mt-[13px] ml-3 size-3.5 shrink-0 cursor-pointer disabled:cursor-not-allowed',
            !selecting &&
              !checked &&
              'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'
          )}
          // onClick rather than onChange: the handler needs shiftKey for
          // range selection. React keeps the box controlled by `checked`.
          readOnly
          onClick={(event) => onToggleChecked(pullKey(pull), event.shiftKey)}
        />
      )}
      {/* The link and the actions overlay share a box, so the overlay sits
          over the link's time and avatar, clear of the group toggle. */}
      <div className="relative flex min-w-0 flex-1">
        <Link
          href={href}
          aria-current={selected ? 'true' : undefined}
          data-pull-row=""
          onPointerEnter={schedulePrefetch}
          onPointerLeave={cancelPrefetch}
          onClick={(event) => {
            // A click within the hover delay already loads the pull.
            cancelPrefetch();
            if (onPreview != null && !isModifiedClick(event)) {
              event.preventDefault();
              onPreview(pull);
              return;
            }
            onOpen(pull);
          }}
          // Middle-click and the context menu's "Open in new tab" skip
          // onClick; both still open the diff from this list, so the list is
          // saved as its queue the same way.
          onAuxClick={(event) => event.button === 1 && onOpen(pull)}
          onContextMenu={() => onOpen(pull)}
          // The ring is inset because section cards clip overflow.
          className="focus-visible:ring-ring flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset"
        >
          <StateIcon
            className={cn('mt-0.5 size-4 shrink-0', stateDisplay.className)}
            aria-label={`${stateDisplay.label} pull request`}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* The repository leads the title, as on GitHub's cross-repo
              list, so it never competes with the label chips for room. Long
              titles wrap to a second line: bot titles keep their most
              telling part ("[security]", the target version) at the end. */}
            <span className="text-foreground line-clamp-2 text-sm font-medium break-words">
              {showRepo && (
                <span className="text-muted-foreground mr-1.5 font-normal">
                  {pull.owner}/{pull.repo}
                </span>
              )}
              {pull.title}
            </span>
            {/* A size container: what fits on this line depends on the row's
              own width (the list narrows beside the preview pane, and group
              leads give room to their toggle), not the viewport's. */}
            <div className="@container flex min-w-0 items-center gap-1.5 overflow-hidden">
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                #{pull.number}
              </span>
              {/* CI and review state sit together after the number: the two
                things that decide whether the pull can merge. They live
                here rather than after the title so the title's two-line
                clamp can never cut them off. */}
              {pull.checks != null ? (
                <ChecksGlyph checks={pull.checks} />
              ) : (
                statusPending && <ChecksPlaceholder />
              )}
              <ReviewDecisionText pull={pull} />
              {pull.activity?.map((activity) => (
                <span
                  key={activity}
                  className={cn(
                    'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium',
                    ACTIVITY_CHIP_CLASSES[activity]
                  )}
                >
                  {PULL_ACTIVITY_LABELS[activity]}
                </span>
              ))}
              <RowLabels labels={pull.labels ?? []} />
            </div>
          </div>
          <RelativeTime
            className="text-muted-foreground mt-0.5 shrink-0 text-xs"
            iso={pull.updatedAt}
            titlePrefix="Updated "
          />
          {pull.authorLogin != null && (
            <span title={`Opened by ${pull.authorLogin}`} className="flex">
              <CommentAuthorAvatar
                author={{
                  avatarUrl: pull.authorAvatarUrl ?? '',
                  login: pull.authorLogin,
                }}
                className="-mt-0.5 size-6"
              />
            </span>
          )}
        </Link>
        {onRowAction != null && (
          <div className="absolute top-2 right-2 z-20">
            <PullRowActions
              authorMuted={authorMuted}
              busy={actionsBusy}
              muteFull={muteFull}
              pull={pull}
              onAction={onRowAction}
            />
          </div>
        )}
      </div>
      {groupKey != null && groupSize > 1 && onToggleGroup != null && (
        <GroupToggle
          expanded={groupExpanded}
          size={groupSize}
          onToggle={() => onToggleGroup(groupKey)}
        />
      )}
    </div>
  );
});

// A group lead's "+N" control: how many near-duplicates (same title and
// author) are folded under it, and the switch to list them.
function GroupToggle({
  expanded,
  onToggle,
  size,
}: {
  expanded: boolean;
  onToggle(): void;
  size: number;
}) {
  const others = size - 1;
  const othersLabel = `${others} matching pull request${others === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? `Fold ${othersLabel}` : `Show ${othersLabel}`}
      className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring mt-2 mr-3 flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-[11px] tabular-nums outline-none focus-visible:ring-2"
      title={
        expanded
          ? 'Fold the matching pull requests back into this row'
          : `${others} more with the same title and author`
      }
      onClick={onToggle}
    >
      {expanded ? 'Fold' : `+${others}`}
      <IconChevronSm
        className={cn('size-3 transition-transform', expanded && 'rotate-180')}
      />
    </button>
  );
}

const CHECKS_GLYPHS: Record<
  PullChecksSummary,
  { className: string; Icon: typeof IconCheck; label: string }
> = {
  failure: {
    className: TONE_TEXT_CLASS.failure,
    Icon: IconX,
    label: 'Some checks failed',
  },
  pending: {
    className: TONE_TEXT_CLASS.pending,
    Icon: IconCircleFill,
    label: 'Checks in progress',
  },
  success: {
    className: TONE_TEXT_CLASS.success,
    Icon: IconCheck,
    label: 'All checks passed',
  },
};

// Every CI state's glyph takes the same width (the pending dot is smaller
// than the other icons), so a status landing or changing doesn't move the
// chips after it.
const CHECKS_SLOT_CLASS =
  'inline-flex w-3 shrink-0 items-center justify-center';

// The head commit's CI result, in GitHub's list glyphs: a check, a cross,
// or (still running) a small dot.
function ChecksGlyph({ checks }: { checks: PullChecksSummary }) {
  const { className, Icon, label } = CHECKS_GLYPHS[checks];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(CHECKS_SLOT_CLASS, className)}
    >
      <Icon
        aria-hidden
        className={checks === 'pending' ? 'size-2' : 'size-3'}
      />
    </span>
  );
}

// Holds the CI glyph's place while the row's status loads: a faint dot the
// size of the pending glyph, so the row reads as "checking" rather than
// jumping when the real glyph arrives.
function ChecksPlaceholder() {
  return (
    <span
      aria-hidden
      className={cn(CHECKS_SLOT_CLASS, 'text-muted-foreground')}
    >
      <span className="size-2 animate-pulse rounded-full bg-current opacity-30" />
    </span>
  );
}

const DECISION_TEXT_CLASSES: Record<PullReviewDecision, string> = {
  approved: TONE_TEXT_CLASS.success,
  'changes-requested': TONE_TEXT_CLASS.failure,
  'review-required': 'text-muted-foreground',
};

// The pull's overall review state ("Approved", "Review required"), which is
// what decides whether it can merge. Skipped when a viewer chip already says
// the same word (the viewer's own approval on a pull that's approved).
function ReviewDecisionText({ pull }: { pull: PullSummary }) {
  const decision = pull.reviewDecision;
  if (
    decision == null ||
    (pull.activity ?? []).some((activity) => activity === decision)
  ) {
    return null;
  }
  return (
    <span
      className={cn(
        'shrink-0 text-xs',
        DECISION_TEXT_CLASSES[decision],
        // The default state for most pulls; the first thing a tight line
        // drops, ahead of the viewer's own involvement chip.
        decision === 'review-required' && '@max-[22rem]:hidden'
      )}
    >
      {PULL_REVIEW_DECISION_LABELS[decision]}
    </span>
  );
}

// The row's labels. With room (a meta line of 26rem or more), the first
// MAX_ROW_LABELS as chips and then a "+N" naming the rest in its tooltip;
// on a narrower line, one "N labels" chip naming them all, so the count
// stays readable instead of chips squeezing down to empty pills.
function RowLabels({ labels }: { labels: readonly PullLabel[] }) {
  if (labels.length === 0) {
    return null;
  }
  const shown = labels.slice(0, MAX_ROW_LABELS);
  const rest = labels.slice(MAX_ROW_LABELS);
  const countChipClass =
    'text-muted-foreground shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none tabular-nums';
  return (
    <>
      <span className="hidden min-w-0 items-center gap-1.5 overflow-hidden @min-[26rem]:flex">
        {shown.map((label) => (
          <LabelChip key={label.name} label={label} />
        ))}
        {rest.length > 0 && (
          <span
            className={countChipClass}
            title={rest.map((label) => label.name).join(', ')}
          >
            +{rest.length}
          </span>
        )}
      </span>
      <span
        className={cn(countChipClass, '@min-[26rem]:hidden')}
        title={labels.map((label) => label.name).join(', ')}
      >
        {labels.length} {labels.length === 1 ? 'label' : 'labels'}
      </span>
    </>
  );
}

// A repository label: the label's own color as a dot, with the name in the
// row's muted text so arbitrary label colors never decide legibility. The
// full name rides in the tooltip for chips that truncate.
function LabelChip({ label }: { label: PullLabel }) {
  return (
    <span
      title={label.name}
      className="text-muted-foreground inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none"
    >
      <LabelColorDot className="size-1.5" color={label.color} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}
