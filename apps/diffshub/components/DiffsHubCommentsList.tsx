'use client';

import type { AnnotationSide } from '@pierre/diffs';
import { IconArrowUpRight, IconConvoFill, IconPlus } from '@pierre/icons';
import { memo, type MouseEvent, useState } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { CommentComposer } from './CommentComposer';
import {
  CommentDeleteConfirm,
  CommentEditComposer,
  CommentModerationButtons,
  useCommentModeration,
} from './CommentModeration';
import { MarkdownContent } from './MarkdownContent';
import { useGitHubUser } from './useGitHubUser';
import { cn } from '@/lib/cn';
import { createCommentSidebarPreview } from '@/lib/commentSidebarPreview';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import type {
  CommentLineType,
  DiffsHubSavedCommentEntry,
  DiffsHubSavedCommentItem,
  PullDiscussionComment,
} from '@/lib/types';

// Card chrome shared by the sidebar's stacked card sections. The border and
// surface come from themed CSS variables (set on the sidebar wrapper) so
// cards stay on-palette for mixed-light/dark themes like slack-ochin
// (light-typed but uses a dark navy sidebar); the hardcoded fallbacks cover
// the brief window before the Shiki theme resolves on first render.
const CARD_BORDER_CLASS =
  'border-[var(--diffshub-card-border,rgb(0_0_0_/_0.1))] dark:border-[var(--diffshub-card-border,rgb(255_255_255_/_0.15))]';

// A row inside a card stack: hairline separators between rows, with the
// stack's outer rounding echoed on the first/last rows.
const CARD_ROW_CLASS = cn(
  CARD_BORDER_CLASS,
  'border-b bg-[var(--diffshub-card-bg,var(--color-card))] first:rounded-t-lg last:rounded-b-lg last:border-b-0'
);

// Write access to the PR-level conversation, provided only on pull-request
// views. `canWrite` mirrors the thread cards' meaning: a token is saved, so
// writes can be attempted at all. Edit/delete only apply to issue comments
// (kind 'comment'); review summaries are read-only.
export interface DiscussionActions {
  canWrite: boolean;
  onDelete(commentId: number): Promise<void>;
  onEdit(commentId: number, body: string): Promise<void>;
  onPost(body: string): Promise<void>;
}

interface DiffsHubCommentsListProps {
  commentSections: readonly DiffsHubSavedCommentItem[];
  // PR-level conversation (issue comments, review summaries) shown in its own
  // section above the per-file threads.
  discussion?: readonly PullDiscussionComment[];
  discussionActions?: DiscussionActions;
  onSelectComment?(comment: DiffsHubSavedCommentEntry): void;
  onSelectItem?(itemId: string): void;
}

// The action phrase after a discussion row's @handle. Review verdicts get
// their own wording (and, below, the add/del accent colors) so approvals and
// change requests read at a glance.
function getDiscussionVerb(comment: PullDiscussionComment): string {
  if (comment.kind === 'comment') {
    return 'commented';
  }
  switch (comment.reviewState) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'requested changes';
    case 'DISMISSED':
      return 'reviewed (dismissed)';
    default:
      return 'reviewed';
  }
}

function getDiscussionVerbClassName(
  comment: PullDiscussionComment
): string | null {
  switch (comment.reviewState) {
    case 'APPROVED':
      return 'text-[var(--diffshub-comment-add-fg,#047857)] dark:text-[var(--diffshub-comment-add-fg,#34d399)] font-medium';
    case 'CHANGES_REQUESTED':
      return 'text-[var(--diffshub-comment-del-fg,#be123c)] dark:text-[var(--diffshub-comment-del-fg,#fb7185)] font-medium';
    default:
      return null;
  }
}

function getCommentLineLabel(
  side: AnnotationSide,
  lineNumber: number,
  lineType: CommentLineType
): string {
  if (lineType === 'context') {
    return `Line ${lineNumber}`;
  }
  const sigil = side === 'additions' ? '+' : '-';
  return `Line ${sigil}${lineNumber}`;
}

function getCommentLineClassName(
  side: AnnotationSide,
  lineType: CommentLineType
): string {
  if (lineType === 'context') {
    return 'text-muted-foreground';
  }
  // The themed chrome sets --diffshub-comment-add-fg / -del-fg with a shade
  // chosen from the active Shiki surface's luminance, so addition/deletion
  // labels stay legible even on mixed-palette themes (e.g. slack-ochin's
  // "light" classification with a dark navy sidebar, where the global
  // `dark:` variant would otherwise leave us with low-contrast 700 shades
  // on a dark card). The Tailwind shades stay as fallbacks for the
  // first-render window before the chrome style applies.
  return side === 'additions'
    ? 'text-[var(--diffshub-comment-add-fg,#047857)] dark:text-[var(--diffshub-comment-add-fg,#34d399)]'
    : 'text-[var(--diffshub-comment-del-fg,#be123c)] dark:text-[var(--diffshub-comment-del-fg,#fb7185)]';
}

// Wraps a click handler so users can drag-select text inside the row without
// also triggering navigation. mouseup after a selection fires click on the
// button; bail out only when the resulting selection is anchored inside this
// row, so a pre-existing selection elsewhere on the page (e.g. in the diff
// viewer) does not block keyboard/mouse activation of the row.
function handleRowClick(event: MouseEvent<HTMLElement>, run: () => void): void {
  if (event.button !== 0) {
    return;
  }
  const selection =
    typeof window !== 'undefined' ? window.getSelection() : null;
  if (selection != null && selection.toString().length > 0) {
    const row = event.currentTarget;
    const anchorInRow =
      selection.anchorNode != null && row.contains(selection.anchorNode);
    const focusInRow =
      selection.focusNode != null && row.contains(selection.focusNode);
    if (anchorInRow || focusInRow) {
      event.preventDefault();
      return;
    }
  }
  run();
}

// A PR-level conversation entry. There is no diff anchor to scroll to, so the
// row's default click expands the body in place — collapsed rows show a
// clamped plain-text preview, expanded rows render the full markdown — so
// reading the comment stays in-app. The upstream GitHub permalink is an
// explicit arrow affordance, matching the embedded thread cards, rather than
// the whole-row default. Signed-in authors get edit/delete on their own
// conversation comments (never on review summaries — see DiscussionActions).
function DiscussionRow({
  actions,
  comment,
}: {
  actions?: DiscussionActions;
  comment: PullDiscussionComment;
}) {
  const [expanded, setExpanded] = useState(false);
  const moderation = useCommentModeration(async () => {
    await actions?.onDelete(comment.id);
  });
  const githubUser = useGitHubUser();
  const canModify =
    actions != null &&
    actions.canWrite &&
    comment.kind === 'comment' &&
    githubUser?.login === comment.author.login;
  const preview = createCommentSidebarPreview(comment.body);

  const toggleExpanded = () => {
    if (!moderation.isEditing && !moderation.isConfirmingDelete) {
      setExpanded((prev) => !prev);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      className={cn(
        CARD_ROW_CLASS,
        'group/discussion focus-visible:ring-ring flex w-full cursor-pointer items-start gap-2 p-3 text-left text-sm outline-none hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))] focus-visible:ring-2'
      )}
      onClick={(event) => {
        // Interactive descendants — markdown links, the edit composer, the
        // action buttons — handle their own clicks; only clicks on the row
        // itself (or inert text) toggle expansion.
        const target = event.target as HTMLElement;
        if (
          target !== event.currentTarget &&
          target.closest('a, button, form') != null
        ) {
          return;
        }
        handleRowClick(event, toggleExpanded);
      }}
      onKeyDown={(event) => {
        if (
          (event.key === 'Enter' || event.key === ' ') &&
          event.target === event.currentTarget
        ) {
          event.preventDefault();
          toggleExpanded();
        }
      }}
    >
      <CommentAuthorAvatar author={comment.author} className="size-5" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 select-text">
        <div className="text-muted-foreground flex w-full flex-wrap items-center gap-x-1">
          <span className="text-foreground font-medium">
            @{comment.author.login}
          </span>
          <span className={cn(getDiscussionVerbClassName(comment))}>
            {getDiscussionVerb(comment)}
          </span>
          <span>· {formatRelativeTime(comment.createdAt)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {canModify && !moderation.isEditing && (
              <span className="flex gap-1 opacity-0 transition-opacity duration-100 group-focus-within/discussion:opacity-100 group-hover/discussion:opacity-100">
                <CommentModerationButtons
                  moderation={moderation}
                  onBeginEdit={() => setExpanded(true)}
                />
              </span>
            )}
            {comment.htmlUrl != null && (
              <a
                className="hover:text-foreground"
                aria-label="Open comment on GitHub"
                title="Open comment on GitHub"
                href={comment.htmlUrl}
                rel="noreferrer noopener"
                target="_blank"
              >
                <IconArrowUpRight size={14} />
              </a>
            )}
          </span>
        </div>
        {moderation.isEditing && actions != null ? (
          <div className="w-full pt-1">
            <CommentEditComposer
              initialBody={comment.body}
              moderation={moderation}
              onEdit={(body) => actions.onEdit(comment.id, body)}
            />
          </div>
        ) : expanded ? (
          <MarkdownContent className="w-full" markdown={comment.body} />
        ) : (
          preview !== '' && (
            <p className="text-foreground line-clamp-6 w-full break-words whitespace-pre-wrap">
              {preview}
            </p>
          )
        )}
        {moderation.isConfirmingDelete && actions != null && (
          <div className="w-full pt-1">
            <CommentDeleteConfirm moderation={moderation} />
          </div>
        )}
      </div>
    </div>
  );
}

// The Conversation section's trailing row: opens a composer that posts a new
// PR-level comment. Anonymous sessions get the same sign-in nudge as thread
// replies instead of a composer they could not submit.
function DiscussionComposerRow({ actions }: { actions: DiscussionActions }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!actions.canWrite) {
    return (
      <div
        className={cn(CARD_ROW_CLASS, 'text-muted-foreground p-3 text-[13px]')}
      >
        Sign in with GitHub or save a token to comment.
      </div>
    );
  }

  return (
    <div className={cn(CARD_ROW_CLASS, 'p-3')}>
      {isOpen ? (
        <CommentComposer
          autoFocus
          submitLabel="Comment"
          onCancel={() => setIsOpen(false)}
          onSubmit={async (body) => {
            await actions.onPost(body);
            setIsOpen(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="text-muted-foreground hover:border-foreground/30 hover:text-foreground w-full cursor-text rounded-md border border-[var(--diffshub-card-border,var(--color-border))] px-3 py-1.5 text-left text-[13px] transition-colors"
          onClick={() => setIsOpen(true)}
        >
          Add a comment…
        </button>
      )}
    </div>
  );
}

export const DiffsHubCommentsList = memo(function DiffsHubCommentsList({
  commentSections,
  discussion = [],
  discussionActions,
  onSelectComment,
  onSelectItem,
}: DiffsHubCommentsListProps) {
  // On pull-request views the Conversation section always renders (its
  // composer is how PR-level comments get written), so the empty state only
  // applies when there is nothing to show AND nothing to write.
  const showConversation = discussion.length > 0 || discussionActions != null;
  if (commentSections.length === 0 && !showConversation) {
    return (
      <div className="text-muted-foreground flex h-full min-h-0 flex-col items-center justify-center gap-2 px-7 text-center text-sm">
        <IconConvoFill size={24} className="mb-2" />
        <div className="flex flex-col">
          <strong className="font-medium">No comments yet</strong>
          <p>
            Hover over a line and click the{' '}
            <span className="light:text-white light:bg-[rgb(0,159,255)] inline-flex h-[20px] w-[20px] items-center justify-center rounded-[4px] align-top dark:bg-[rgb(0,159,255)] dark:text-black">
              <IconPlus />
            </span>{' '}
            button to add code comments.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'cv-mini-scrollbar',
        'h-full min-h-0 overflow-auto overscroll-contain pl-3 pb-3 pr-[max(0px,calc(12px-var(--cv-mini-gutter-vertical)))]'
      )}
    >
      {showConversation && (
        <section>
          <div className="text-muted-foreground p-3 pb-2 text-sm font-medium">
            Conversation
          </div>
          <div className={cn(CARD_BORDER_CLASS, 'rounded-lg border')}>
            {discussion.map((comment) => (
              <DiscussionRow
                key={`${comment.kind}-${comment.id}`}
                actions={discussionActions}
                comment={comment}
              />
            ))}
            {discussionActions != null && (
              <DiscussionComposerRow actions={discussionActions} />
            )}
          </div>
        </section>
      )}
      {commentSections.map((section) => (
        <section key={section.itemId}>
          {onSelectItem != null ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring block w-full cursor-pointer p-3 pb-2 text-left text-sm font-medium break-all outline-none focus-visible:ring-2"
              onClick={(event) =>
                handleRowClick(event, () => onSelectItem(section.itemId))
              }
            >
              <span className="select-text">{section.path}</span>
            </button>
          ) : (
            <div className="text-muted-foreground p-3 pb-2 text-sm font-medium break-all">
              {section.path}
            </div>
          )}
          <div className={cn(CARD_BORDER_CLASS, 'rounded-lg border')}>
            {section.comments.map((comment) => (
              <button
                key={comment.key}
                type="button"
                // No `transition-colors` here: the bg / border / text
                // colors are driven by CSS variables that flip the entire
                // chrome on every theme swap, so a smooth color transition
                // on each card visibly trails the rest of the UI (header,
                // file tree, diff body) which snap instantly. Hover bg is
                // snappy enough without an interpolated transition.
                className={cn(
                  CARD_ROW_CLASS,
                  'focus-visible:ring-ring flex w-full cursor-pointer items-start gap-2 p-3 text-left text-sm outline-none hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))] focus-visible:ring-2'
                )}
                onClick={(event) =>
                  handleRowClick(event, () => onSelectComment?.(comment))
                }
              >
                <CommentAuthorAvatar
                  author={comment.author}
                  className="size-5"
                />
                <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 select-text">
                  <div className="text-muted-foreground flex flex-wrap gap-x-1">
                    <span className="text-foreground font-medium">
                      @{comment.author.login}
                    </span>
                    <span>commented on</span>
                    <span
                      className={cn(
                        getCommentLineClassName(comment.side, comment.lineType),
                        'font-medium'
                      )}
                    >
                      {getCommentLineLabel(
                        comment.side,
                        comment.lineNumber,
                        comment.lineType
                      )}
                    </span>
                  </div>
                  <p className="text-foreground w-full break-words whitespace-pre-wrap">
                    {comment.message}
                  </p>
                  {comment.replyCount > 0 && (
                    <div className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[12px]">
                      <span className="flex -space-x-1.5">
                        {comment.participants.slice(0, 4).map((participant) => (
                          <CommentAuthorAvatar
                            key={participant.login}
                            author={participant}
                            className="size-4 text-[8px] ring-2 ring-[var(--diffshub-card-bg,var(--color-card))]"
                          />
                        ))}
                      </span>
                      <span>
                        {comment.replyCount}{' '}
                        {comment.replyCount === 1 ? 'reply' : 'replies'}
                        {comment.participants.length > 1 &&
                          ` · ${comment.participants.length} participants`}
                      </span>
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});
