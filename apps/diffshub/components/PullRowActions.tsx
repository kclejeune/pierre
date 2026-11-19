'use client';

import {
  IconArrowUpRight,
  IconBrandGithub,
  IconCheckCircle,
  IconEllipsis,
  IconEyeSlash,
  IconLink,
  IconMerged,
} from '@pierre/icons';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { useQueuedPullPath } from './PullQueueLinkContext';
import { useDropdownChromeStyle } from './useDropdownChromeStyle';
import { cn } from '@/lib/cn';
import { copyToClipboard } from '@/lib/copyToClipboard';
import { githubPullURL, type PullSummary } from '@/lib/githubPullSummaries';
import { authorSearchName, mutedAuthorLabel } from '@/lib/mutedAuthors';

// Mutes `author` and toasts an Undo, since their pulls then leave /pulls.
// Shared by the list rows and the review page so both say the same thing.
export function muteWithUndo(
  author: string,
  mute: (authors: readonly string[]) => void,
  unmute: (author: string) => void
): void {
  mute([author]);
  toast(`Muted ${mutedAuthorLabel(author)}`, {
    description: 'Their pull requests are left out of /pulls.',
    action: { label: 'Undo', onClick: () => unmute(author) },
  });
}

// What a row's menu asks the list to do. Copying links happens in the menu
// itself; these need the list's batch runner or muted list, and 'open' (the
// new-tab item, which the link itself performs) lets the list record the
// open and save itself as the diff's queue.
export type PullRowAction = 'approve' | 'merge' | 'mute' | 'open' | 'unmute';

interface PullRowActionsProps {
  // The row's author is on the muted list.
  authorMuted: boolean;
  // A batch (or another row's action) is running; approve and merge wait.
  busy: boolean;
  // The muted list is full, so a new author can't be muted.
  muteFull: boolean;
  // Extra classes for the trigger (the review header styles it as one of
  // its PR segment's items).
  className?: string;
  onAction(pull: PullSummary, action: PullRowAction): void;
  pull: PullSummary;
  // 'row' (the /pulls list) reveals the trigger on row hover and offers
  // "Open in new tab"; 'header' (the review page, already showing the pull)
  // keeps the trigger visible and leaves that item out.
  variant?: 'header' | 'row';
}

// A pull's "⋯" actions menu, on /pulls rows and in the review page header:
// the batch bar's approve and merge-when-ready for just this pull (no
// checkbox needed), copying its diffshub or GitHub link, opening it in a new
// tab (rows only), and muting its author. On rows it's revealed on hover or
// focus over the top-right corner, and kept visible while open. Merging
// can't be undone, so its item asks again before it runs.
export function PullRowActions({
  authorMuted,
  busy,
  className,
  muteFull,
  onAction,
  pull,
  variant = 'row',
}: PullRowActionsProps) {
  // The menu's contents mount only while it's open: every /pulls row has
  // this menu, and its chrome theme and links are only needed once shown.
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${pull.owner}/${pull.repo}#${pull.number}`}
          title="Pull request actions"
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring flex cursor-pointer items-center justify-center outline-none focus-visible:ring-2',
            variant === 'row' &&
              'bg-background size-7 rounded-md border opacity-0 shadow-xs group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
            className
          )}
        >
          <IconEllipsis className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      {menuOpen && (
        <PullRowActionsMenu
          authorMuted={authorMuted}
          busy={busy}
          muteFull={muteFull}
          pull={pull}
          variant={variant}
          onAction={onAction}
        />
      )}
    </DropdownMenu>
  );
}

// The open menu's items. Mounted per opening, so the merge confirmation
// resets each time the menu closes.
function PullRowActionsMenu({
  authorMuted,
  busy,
  muteFull,
  onAction,
  pull,
  variant,
}: Omit<PullRowActionsProps, 'className'>) {
  const dropdownStyle = useDropdownChromeStyle();
  const { webURL } = useGitHubEnvironment();
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const queuedPath = useQueuedPullPath(pull.viewerPath);
  const author = authorSearchName(pull);
  const open = pull.state === 'open' || pull.state === 'draft';
  const githubHref = githubPullURL(webURL, pull);
  return (
    <DropdownMenuContent align="end" className="min-w-52" style={dropdownStyle}>
      {open && (
        <>
          <DropdownMenuItem
            className="gap-2"
            disabled={busy}
            onSelect={() => onAction(pull, 'approve')}
          >
            <IconCheckCircle className="size-3.5" />
            Approve
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn(
              'gap-2',
              confirmingMerge && 'text-emerald-600 dark:text-emerald-400'
            )}
            disabled={busy}
            title="Join the merge queue where there is one, otherwise merge with the repository's default method"
            onSelect={(event) => {
              if (!confirmingMerge) {
                event.preventDefault();
                setConfirmingMerge(true);
                return;
              }
              onAction(pull, 'merge');
            }}
          >
            <IconMerged className="size-3.5" />
            {confirmingMerge
              ? `Confirm merge of #${pull.number}`
              : 'Merge when ready'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem
        className="gap-2"
        onSelect={() =>
          copyToClipboard(
            new URL(pull.viewerPath, window.location.origin).href,
            'Link'
          )
        }
      >
        <IconLink className="size-3.5" />
        Copy link
      </DropdownMenuItem>
      <DropdownMenuItem
        className="gap-2"
        onSelect={() => copyToClipboard(githubHref, 'GitHub link')}
      >
        <IconBrandGithub className="size-3.5" />
        Copy GitHub link
      </DropdownMenuItem>
      {variant === 'row' && (
        <DropdownMenuItem asChild className="gap-2">
          <a
            href={queuedPath}
            rel="noopener"
            target="_blank"
            onClick={() => onAction(pull, 'open')}
          >
            <IconArrowUpRight className="size-3.5" />
            Open in new tab
          </a>
        </DropdownMenuItem>
      )}
      {author != null && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2"
            disabled={!authorMuted && muteFull}
            title={
              !authorMuted && muteFull ? 'The muted list is full' : undefined
            }
            onSelect={() => onAction(pull, authorMuted ? 'unmute' : 'mute')}
          >
            <IconEyeSlash className="size-3.5" />
            {authorMuted ? 'Unmute' : 'Mute'} {mutedAuthorLabel(author)}
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  );
}
