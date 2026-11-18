'use client';

import Link from 'next/link';
import type { MouseEvent } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { LabelColorDot } from './LabelColorDot';
import { PULL_STATE_DISPLAY } from './pullStateDisplay';
import { RelativeTime } from './RelativeTime';
import { cn } from '@/lib/cn';
import {
  PULL_ACTIVITY_LABELS,
  type PullActivity,
  type PullSummary,
} from '@/lib/githubPullSummaries';
import type { PullLabel } from '@/lib/pullInfoClient';
import { recordRecentDiff } from '@/lib/recentDiffs';

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

interface PullRequestRowProps {
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

// One dashboard pull row. Clicking records the diff in recents with its title,
// which the patch stream lacks.
export function PullRequestRow({
  onPreview,
  pull,
  selected = false,
  showRepo = true,
}: PullRequestRowProps) {
  const stateDisplay = PULL_STATE_DISPLAY[pull.state];
  const StateIcon = stateDisplay.Icon;
  return (
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
        recordRecentDiff({ path: pull.viewerPath, title: pull.title });
      }}
      // The ring is inset because section cards clip overflow.
      className={cn(
        'focus-visible:ring-ring flex items-center gap-3 border-b p-3 transition-colors outline-none first:rounded-t-lg last:rounded-b-lg last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset',
        selected
          ? // Full-contrast edge: the palette is monochrome, so the
            // selection that ties this row to the preview pane is marked
            // by contrast rather than an accent hue.
            'bg-accent shadow-[inset_2px_0_0_var(--color-foreground)]'
          : 'hover:bg-accent/60'
      )}
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
          {pull.labels?.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
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
