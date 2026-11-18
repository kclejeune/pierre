'use client';

import { IconChevronSm } from '@pierre/icons';
import Link from 'next/link';
import { memo, type MouseEvent } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { LabelColorDot } from './LabelColorDot';
import { PULL_STATE_DISPLAY } from './pullStateDisplay';
import { RelativeTime } from './RelativeTime';
import { cn } from '@/lib/cn';
import {
  PULL_ACTIVITY_LABELS,
  type PullActivity,
  pullKey,
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
  // Plain clicks preview the pull instead of navigating when set (the wide
  // /pulls layout); modified clicks still follow the link.
  onPreview?(pull: PullSummary): void;
  pull: PullSummary;
  // The pull shown in the preview pane.
  selected?: boolean;
  // Hide the owner/repo label inside sections already scoped to one repo.
  showRepo?: boolean;
}

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
  checked = false,
  groupExpanded = false,
  groupKey,
  groupSize = 1,
  muted = false,
  nested = false,
  onOpen,
  onPreview,
  onToggleChecked,
  onToggleGroup,
  pull,
  selected = false,
  selecting = false,
  selectionLocked = false,
  showRepo = true,
}: PullRequestRowProps) {
  const stateDisplay = PULL_STATE_DISPLAY[pull.state];
  const StateIcon = stateDisplay.Icon;
  return (
    <div
      className={cn(
        'group/row flex items-center border-b transition-colors first:rounded-t-lg last:rounded-b-lg last:border-b-0',
        selected
          ? // Full-contrast edge: the palette is monochrome, so the
            // selection that ties this row to the preview pane is marked
            // by contrast rather than an accent hue.
            'bg-accent shadow-[inset_2px_0_0_var(--color-foreground)]'
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
            'accent-foreground ml-3 size-3.5 shrink-0 cursor-pointer disabled:cursor-not-allowed',
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
      <Link
        href={pull.viewerPath}
        aria-current={selected ? 'true' : undefined}
        data-pull-row=""
        onClick={(event) => {
          if (onPreview != null && !isModifiedClick(event)) {
            event.preventDefault();
            onPreview(pull);
            return;
          }
          onOpen(pull);
        }}
        // The ring is inset because section cards clip overflow.
        className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 p-3 outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <StateIcon
          className={cn('size-4 shrink-0', stateDisplay.className)}
          aria-label={`${stateDisplay.label} pull request`}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-foreground truncate text-sm font-medium">
            {pull.title}
          </span>
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span className="text-muted-foreground truncate text-xs">
              {showRepo ? `${pull.owner}/${pull.repo} ` : ''}#{pull.number}
            </span>
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
          className="text-muted-foreground shrink-0 text-xs"
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
              className="size-6 self-center"
            />
          </span>
        )}
      </Link>
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
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring mr-3 flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-[11px] tabular-nums outline-none focus-visible:ring-2"
      title={
        expanded
          ? 'Fold the matching pull requests back into this row'
          : `${size - 1} more with the same title and author`
      }
      onClick={onToggle}
    >
      {expanded ? 'Fold' : `+${size - 1}`}
      <IconChevronSm
        className={cn('size-3 transition-transform', expanded && 'rotate-180')}
      />
    </button>
  );
}

// The row's first MAX_ROW_LABELS labels, then a "+N" chip naming the rest in
// its tooltip.
function RowLabels({ labels }: { labels: readonly PullLabel[] }) {
  const shown = labels.slice(0, MAX_ROW_LABELS);
  const rest = labels.slice(MAX_ROW_LABELS);
  return (
    <>
      {shown.map((label) => (
        <LabelChip key={label.name} label={label} />
      ))}
      {rest.length > 0 && (
        <span
          className="text-muted-foreground shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none tabular-nums"
          title={rest.map((label) => label.name).join(', ')}
        >
          +{rest.length}
        </span>
      )}
    </>
  );
}

// A repository label: the label's own color as a dot, with the name in the
// row's muted text so arbitrary label colors never decide legibility.
function LabelChip({ label }: { label: PullLabel }) {
  return (
    <span className="text-muted-foreground inline-flex max-w-40 shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none">
      <LabelColorDot className="size-1.5" color={label.color} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}
