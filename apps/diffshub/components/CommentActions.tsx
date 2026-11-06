'use client';

import { IconEllipsis } from '@pierre/icons';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CommentModeration } from './CommentModeration';
import {
  AddReactionButton,
  type CommentReactionsState,
} from './CommentReactions';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { useIsPullAuthor } from './PullAuthorContext';
import { RelativeTime } from './RelativeTime';
import { useDropdownChromeStyle } from './useDropdownChromeStyle';
import { Button } from '@/components/Button';
import { cn } from '@/lib/cn';

// Comment-header pieces shared by the inline review threads and the
// sidebar's Conversation rows, so a comment's badge, timestamp, and actions
// look and behave the same wherever it shows.

// GitHub's "Author" pill, marking comments by the pull request's author.
function AuthorPill() {
  return (
    <span
      className="text-muted-foreground mr-1 inline-flex h-[18px] shrink-0 items-center rounded-full border border-[var(--diffshub-annotation-border,var(--diffshub-card-border,var(--color-border)))] px-1.5 text-[11px] leading-none font-medium"
      title="This user is the author of this pull request."
    >
      Author
    </span>
  );
}

// A comment's age, linking to the comment on GitHub when it has a permalink
// (GitHub's own timestamps are the comment links).
export function CommentTimestamp({
  className,
  htmlUrl,
  iso,
}: {
  className?: string;
  htmlUrl: string | null;
  iso: string;
}) {
  const time = (
    <RelativeTime className={cn('text-[12px]', className)} iso={iso} />
  );
  if (htmlUrl == null) {
    return time;
  }
  return (
    <a
      className="text-muted-foreground hover:text-foreground rounded-sm no-underline hover:underline"
      href={htmlUrl}
      rel="noreferrer noopener"
      target="_blank"
    >
      {time}
    </a>
  );
}

interface CommentMenuProps {
  // Own-comment edit and delete; only offered when true.
  canModify: boolean;
  htmlUrl: string | null;
  moderation: CommentModeration;
  // Runs before the edit composer opens (e.g. expanding a collapsed row).
  onBeginEdit?(): void;
  // Offered as "Quote reply" when set; sites without a reply box omit it.
  onQuoteReply?(): void;
}

// The right side of a comment header: the Author badge (when the commenter
// opened the pull request), the reaction picker, and the overflow menu. The
// picker and menu hide while the comment is being edited. Renders nothing
// when none applies.
export function CommentHeaderActions({
  authorLogin,
  editing,
  menu,
  reactions,
}: {
  authorLogin: string;
  editing: boolean;
  menu: CommentMenuProps;
  reactions: CommentReactionsState;
}) {
  const isAuthor = useIsPullAuthor(authorLogin);
  const showPicker = !editing && reactions.interactive;
  const showMenu =
    !editing &&
    (menu.htmlUrl != null || menu.onQuoteReply != null || menu.canModify);
  if (!isAuthor && !showPicker && !showMenu) {
    return null;
  }
  return (
    <span className="-mr-1 ml-auto flex shrink-0 items-center gap-0.5">
      {isAuthor && <AuthorPill />}
      {showPicker && <AddReactionButton state={reactions} />}
      {showMenu && <CommentMenu {...menu} />}
    </span>
  );
}

// The per-comment overflow menu: link actions, quote reply, and (on the
// viewer's own comments) edit and delete. The menu body mounts only while
// open so closed menus don't each resolve the dropdown chrome theme.
function CommentMenu(props: CommentMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Comment actions"
          title="Comment actions"
          className="text-muted-foreground size-6 rounded-full"
          disabled={props.moderation.isDeleting}
        >
          <IconEllipsis size={14} />
        </Button>
      </DropdownMenuTrigger>
      {open && <CommentMenuContent {...props} />}
    </DropdownMenu>
  );
}

function CommentMenuContent({
  canModify,
  htmlUrl,
  moderation,
  onBeginEdit,
  onQuoteReply,
}: CommentMenuProps) {
  const dropdownStyle = useDropdownChromeStyle();
  const hasLinkGroup = htmlUrl != null || onQuoteReply != null;
  return (
    <DropdownMenuContent
      align="end"
      className="min-w-40"
      style={dropdownStyle}
      // Radix returns focus to the trigger after the menu closes. Skip that
      // when an item already moved focus on purpose (Edit and Quote reply
      // open autofocused composers); only restore focus that was lost to the
      // page body when the menu unmounted.
      onCloseAutoFocus={(event) => {
        const active = document.activeElement;
        if (active != null && active !== document.body) {
          event.preventDefault();
        }
      }}
    >
      {htmlUrl != null && (
        <>
          <DropdownMenuItem
            onSelect={() => {
              navigator.clipboard.writeText(htmlUrl).then(
                () => toast('Link copied'),
                () => toast.error('The link could not be copied.')
              );
            }}
          >
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={htmlUrl} rel="noreferrer noopener" target="_blank">
              Open on GitHub
            </a>
          </DropdownMenuItem>
        </>
      )}
      {onQuoteReply != null && (
        <DropdownMenuItem onSelect={onQuoteReply}>Quote reply</DropdownMenuItem>
      )}
      {canModify && (
        <>
          {hasLinkGroup && <DropdownMenuSeparator />}
          <DropdownMenuItem
            onSelect={() => {
              onBeginEdit?.();
              moderation.startEditing();
            }}
          >
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="danger"
            onSelect={moderation.requestDelete}
          >
            Delete
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  );
}
