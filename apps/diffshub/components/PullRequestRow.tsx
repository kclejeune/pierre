'use client';

import { IconBranch, IconDraft } from '@pierre/icons';
import Link from 'next/link';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { RelativeTime } from './RelativeTime';
import { cn } from '@/lib/cn';
import {
  PULL_ACTIVITY_LABELS,
  type PullActivity,
  type PullSummary,
} from '@/lib/githubPullSummaries';
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
                ACTIVITY_CHIP_CLASSES[activity]
              )}
            >
              {PULL_ACTIVITY_LABELS[activity]}
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
