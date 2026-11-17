'use client';

import {
  IconCheck,
  IconChevronSm,
  IconClockArrow,
  IconCopy,
  IconDraft,
  IconX,
} from '@pierre/icons';
import type { ReactNode } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { PULL_STATE_DISPLAY } from './pullStateDisplay';
import { RefPillArrow } from './RefPicker';
import { RelativeTime } from './RelativeTime';
import { annotationBorderColor } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import { copyToClipboard } from '@/lib/copyToClipboard';
import { formatPullHeadLabel } from '@/lib/diffRefs';
import type { PullDetails, PullInfo } from '@/lib/pullInfoClient';
import {
  diffstatBlocks,
  type OverviewCell,
  type OverviewHeadline,
  type OverviewTone,
} from '@/lib/pullOverview';
import type { DiffsHubDiffStats } from '@/lib/types';

const TONE_BG_CLASS: Record<OverviewTone, string> = {
  failure: 'bg-red-500',
  neutral: 'bg-[color-mix(in_srgb,currentColor_30%,transparent)]',
  pending: 'bg-amber-500',
  success: 'bg-[#18a46c]',
};

// Also colors the check rows and CI dot in PullDetailsControl.
export const TONE_TEXT_CLASS: Record<OverviewTone, string> = {
  failure: 'text-red-500',
  neutral: 'text-muted-foreground',
  pending: 'text-amber-500',
  success: 'text-[#18a46c]',
};

const DIFFSTAT_SQUARE_CLASS: Record<
  ReturnType<typeof diffstatBlocks>[number],
  string
> = {
  added: TONE_BG_CLASS.success,
  deleted: TONE_BG_CLASS.failure,
  neutral: 'bg-[color-mix(in_srgb,currentColor_25%,transparent)]',
};

// The headline's filled status circle. Merged and closed take their glyphs
// from PULL_STATE_DISPLAY so they match the state badge in the same panel.
const HEADLINE_DISPLAY: Record<
  OverviewHeadline['tone'],
  { className: string; Icon: typeof IconCheck }
> = {
  closed: {
    className: 'bg-red-600 text-white',
    Icon: PULL_STATE_DISPLAY.closed.Icon,
  },
  failure: { className: `${TONE_BG_CLASS.failure} text-white`, Icon: IconX },
  merged: {
    className: 'bg-violet-600 text-white',
    Icon: PULL_STATE_DISPLAY.merged.Icon,
  },
  neutral: {
    className: 'bg-[color-mix(in_srgb,currentColor_15%,transparent)]',
    Icon: IconDraft,
  },
  pending: {
    className: `${TONE_BG_CLASS.pending} text-white`,
    Icon: IconClockArrow,
  },
  success: {
    className: `${TONE_BG_CLASS.success} text-white`,
    Icon: IconCheck,
  },
};

// The line under the pull title, after GitHub's PR header: who opened it and
// when, the base ← head branches (owner-qualified for forks, head copyable),
// and the +/− line counts with the five-square diffstat.
export function PullOverviewMeta({
  details,
  diffStats,
  pullInfo,
}: {
  details: PullDetails;
  diffStats: DiffsHubDiffStats | null;
  pullInfo: PullInfo | null;
}) {
  return (
    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
      {details.authorLogin != null && (
        <span className="flex min-w-0 items-center gap-1.5">
          <CommentAuthorAvatar
            author={{
              avatarUrl: details.authorAvatarUrl ?? '',
              login: details.authorLogin,
            }}
            className="size-4 self-center"
          />
          <span className="text-foreground font-medium">
            {details.authorLogin}
          </span>
          {details.createdAt != null && (
            <span>
              opened{' '}
              <RelativeTime iso={details.createdAt} titlePrefix="Opened " />
            </span>
          )}
        </span>
      )}
      {pullInfo != null && (
        <span className="flex min-w-0 items-center gap-1">
          <BranchChip label={pullInfo.baseRef} />
          <RefPillArrow />
          <BranchChip
            copyValue={pullInfo.headRef}
            label={formatPullHeadLabel(pullInfo)}
          />
        </span>
      )}
      {diffStats != null && (
        <span className="flex items-center gap-1.5 font-mono tabular-nums">
          <span className={TONE_TEXT_CLASS.success}>
            +{diffStats.addedLines}
          </span>
          <span className={TONE_TEXT_CLASS.failure}>
            −{diffStats.deletedLines}
          </span>
          <DiffstatSquares
            added={diffStats.addedLines}
            deleted={diffStats.deletedLines}
          />
        </span>
      )}
    </div>
  );
}

function BranchChip({
  copyValue,
  label,
}: {
  // The raw branch name to copy, when copying is offered. Kept apart from
  // `label`, which for fork pulls reads `owner:branch` and is not a valid
  // branch name to check out.
  copyValue?: string;
  label: string;
}) {
  return (
    <span className="flex max-w-56 min-w-0 items-center rounded-md bg-blue-500/10 font-mono text-[11px] text-blue-600 dark:text-blue-400">
      <span className="truncate px-1.5 py-0.5" title={label}>
        {label}
      </span>
      {copyValue != null && (
        <button
          type="button"
          title="Copy branch name"
          aria-label="Copy branch name"
          className="flex shrink-0 items-center self-stretch border-l border-blue-500/20 px-1 hover:bg-blue-500/15"
          onClick={() => copyToClipboard(copyValue, 'Branch name')}
        >
          <IconCopy className="size-3" />
        </button>
      )}
    </span>
  );
}

function DiffstatSquares({
  added,
  deleted,
}: {
  added: number;
  deleted: number;
}) {
  return (
    <span
      aria-label={`${added} additions, ${deleted} deletions`}
      className="flex gap-px"
    >
      {diffstatBlocks(added, deleted).map((kind, index) => (
        <span
          key={index}
          className={cn('size-2 rounded-[1px]', DIFFSTAT_SQUARE_CLASS[kind])}
        />
      ))}
    </span>
  );
}

interface MergeStatusCardProps {
  // Merge, update, or other controls shown beside the headline.
  actions?: ReactNode;
  approvals: OverviewCell;
  checks: OverviewCell;
  // The per-check list, shown under the cells while the Checks cell is
  // expanded.
  checksDetail?: ReactNode;
  checksExpanded: boolean;
  comments: OverviewCell;
  headline: OverviewHeadline;
  onToggleChecks(): void;
}

// GitHub's overview merge box: a headline naming what blocks (or allows) the
// merge, then Checks / Comments / Approvals cells with segmented progress
// bars. The Checks cell expands to the per-check list.
export function MergeStatusCard({
  actions,
  approvals,
  checks,
  checksDetail,
  checksExpanded,
  comments,
  headline,
  onToggleChecks,
}: MergeStatusCardProps) {
  const display = HEADLINE_DISPLAY[headline.tone];
  return (
    <section
      aria-label="Merge status"
      className={cn('overflow-hidden rounded-md border', annotationBorderColor)}
    >
      <div className="flex items-start gap-2.5 p-3">
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full',
            display.className
          )}
        >
          <display.Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="m-0 text-sm font-semibold">{headline.title}</h4>
          <p className="text-muted-foreground m-0 text-xs">{headline.detail}</p>
        </div>
      </div>
      {actions != null && <div className="px-3 pb-3">{actions}</div>}
      <div className={cn('grid grid-cols-3 border-t', annotationBorderColor)}>
        <MetricCell
          cell={checks}
          label="Checks"
          onToggle={onToggleChecks}
          expanded={checksExpanded}
        />
        <MetricCell cell={comments} label="Comments" />
        <MetricCell cell={approvals} label="Approvals" />
      </div>
      {checksExpanded && checksDetail != null && (
        <div className={cn('border-t p-2.5', annotationBorderColor)}>
          {checksDetail}
        </div>
      )}
    </section>
  );
}

// One Checks / Comments / Approvals cell: label, summary, and bar. Passing
// `onToggle` makes the cell a disclosure button (Checks expands its list).
function MetricCell({
  cell,
  expanded = false,
  label,
  onToggle,
}: {
  cell: OverviewCell;
  expanded?: boolean;
  label: string;
  onToggle?(): void;
}) {
  const summary =
    cell.kind === 'metric'
      ? cell.summary
      : cell.kind === 'loading'
        ? 'Loading…'
        : 'Unavailable';
  const content = (
    <>
      <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
        <span className="shrink-0 font-semibold">{label}</span>
        <span
          title={cell.kind === 'unavailable' ? cell.reason : summary}
          className={cn(
            'min-w-0 truncate',
            cell.kind === 'metric' && cell.tone != null
              ? TONE_TEXT_CLASS[cell.tone]
              : 'text-muted-foreground'
          )}
        >
          {summary}
        </span>
        {onToggle != null && (
          <IconChevronSm
            aria-hidden="true"
            className={cn(
              'text-muted-foreground ml-auto size-3 shrink-0 transition-transform',
              !expanded && '-rotate-90'
            )}
          />
        )}
      </span>
      <MetricBar cell={cell} />
    </>
  );
  const className = `flex min-w-0 flex-col gap-1.5 p-2.5 not-first:border-l text-left ${annotationBorderColor}`;
  if (onToggle == null) {
    return <div className={className}>{content}</div>;
  }
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className={cn(
        className,
        'outline-none hover:bg-[color-mix(in_srgb,currentColor_5%,transparent)] focus-visible:bg-[color-mix(in_srgb,currentColor_5%,transparent)]'
      )}
      onClick={onToggle}
    >
      {content}
    </button>
  );
}

// Segments sized by count with hairline gaps; nothing to show (or loading)
// draws GitHub's hatched placeholder track.
function MetricBar({ cell }: { cell: OverviewCell }) {
  if (cell.kind !== 'metric' || cell.segments.length === 0) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'block h-1.5 w-full rounded-full bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,currentColor_18%,transparent)_0_2px,transparent_2px_5px)]',
          cell.kind === 'loading' && 'animate-pulse'
        )}
      />
    );
  }
  return (
    <span aria-hidden="true" className="flex h-1.5 w-full gap-px">
      {cell.segments.map((segment) => (
        <span
          key={segment.tone}
          className={cn(
            'h-full min-w-1 first:rounded-l-full last:rounded-r-full',
            TONE_BG_CLASS[segment.tone]
          )}
          style={{ flexGrow: segment.count }}
        />
      ))}
    </span>
  );
}
