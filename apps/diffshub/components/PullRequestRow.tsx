'use client';

import { IconBranch, IconDraft } from '@pierre/icons';
import Link from 'next/link';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { RelativeTime } from './RelativeTime';
import { cn } from '@/lib/cn';
import type { PullActivity, PullSummary } from '@/lib/githubPullSummaries';
import { recordRecentDiff } from '@/lib/recentDiffs';

// Chips for the viewer's involvement on "active" rows. Pending requests read
// in amber (waiting on you), verdicts in the green/red the pull details
// reviewer list uses, and plain participation stays muted.
const ACTIVITY_CHIPS: Record<
  PullActivity,
  { className: string; label: string }
> = {
  'review-requested': {
    className: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
    label: 'Review requested',
  },
  'team-review-requested': {
    className: 'text-muted-foreground',
    label: 'Team review requested',
  },
  approved: {
    className: 'border-[#18a46c]/40 text-[#18a46c]',
    label: 'Approved',
  },
  'changes-requested': {
    className: 'border-red-500/40 text-red-600 dark:text-red-400',
    label: 'Changes requested',
  },
  reviewed: { className: 'text-muted-foreground', label: 'Reviewed' },
  commented: { className: 'text-muted-foreground', label: 'Commented' },
};

interface PullRequestRowProps {
  pull: PullSummary;
  // Hide the owner/repo label inside sections already scoped to one repo.
  showRepo?: boolean;
}

// One dashboard pull row. Clicking records the diff in recents with its title,
// which the patch stream lacks.
export function PullRequestRow({ pull, showRepo = true }: PullRequestRowProps) {
  const StateIcon = pull.state === 'draft' ? IconDraft : IconBranch;
  return (
    <Link
      href={pull.viewerPath}
      onClick={() =>
        recordRecentDiff({ path: pull.viewerPath, title: pull.title })
      }
      // The ring is inset because section cards clip overflow.
      className="hover:bg-accent/60 focus-visible:ring-ring flex items-center gap-3 border-b p-3 transition-colors outline-none first:rounded-t-lg last:rounded-b-lg last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset"
    >
      <StateIcon
        className={cn(
          'size-4 shrink-0',
          pull.state === 'draft' ? 'text-muted-foreground' : 'text-[#18a46c]'
        )}
        aria-label={
          pull.state === 'draft' ? 'Draft pull request' : 'Open pull request'
        }
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground truncate text-sm font-medium">
          {pull.title}
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-muted-foreground truncate text-xs">
            {showRepo ? `${pull.owner}/${pull.repo} ` : ''}#{pull.number}
          </span>
          {pull.activity?.map((activity) => (
            <span
              key={activity}
              className={cn(
                'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium',
                ACTIVITY_CHIPS[activity].className
              )}
            >
              {ACTIVITY_CHIPS[activity].label}
            </span>
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
