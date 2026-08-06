'use client';

import { IconBranch, IconDraft } from '@pierre/icons';
import Link from 'next/link';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import type { PullSummary } from '@/lib/githubPullSummaries';
import { recordRecentDiff } from '@/lib/recentDiffs';

interface PullRequestRowProps {
  pull: PullSummary;
  // Hide the owner/repo label inside sections already scoped to one repo.
  showRepo?: boolean;
}

// One pull request in a dashboard card stack: state icon, title, repo and
// number, author avatar, and relative update time. Clicking records the diff
// (with its title, which the viewer alone cannot recover from the patch
// stream) into the recents list before navigating into the viewer.
export function PullRequestRow({ pull, showRepo = true }: PullRequestRowProps) {
  const StateIcon = pull.state === 'draft' ? IconDraft : IconBranch;
  return (
    <Link
      href={pull.viewerPath}
      onClick={() =>
        recordRecentDiff({ path: pull.viewerPath, title: pull.title })
      }
      className="hover:bg-accent/60 flex items-center gap-3 border-b p-3 transition-colors first:rounded-t-lg last:rounded-b-lg last:border-b-0"
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
        <span className="text-muted-foreground truncate text-xs">
          {showRepo ? `${pull.owner}/${pull.repo} ` : ''}#{pull.number}
          {pull.authorLogin != null ? ` · ${pull.authorLogin}` : ''}
        </span>
      </div>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {formatRelativeTime(pull.updatedAt)}
      </span>
      {pull.authorLogin != null && (
        <CommentAuthorAvatar
          author={{
            avatarUrl: pull.authorAvatarUrl ?? '',
            login: pull.authorLogin,
          }}
          className="size-6"
        />
      )}
    </Link>
  );
}
