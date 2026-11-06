'use client';

import type { DiffLineAnnotation } from '@pierre/diffs';
import { IconArrowUpRight } from '@pierre/icons';
import { memo, useState } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { CommentComposer } from './CommentComposer';
import {
  CommentDeleteConfirm,
  CommentEditComposer,
  CommentModerationButtons,
  useCommentModeration,
} from './CommentModeration';
import { CommentReactions } from './CommentReactions';
import {
  DeferredMarkdownContent,
  type SuggestionTarget,
  SuggestionTargetContext,
} from './MarkdownContent';
import { RelativeTime } from './RelativeTime';
import { useGitHubUser } from './useGitHubUser';
import { Button } from '@/components/Button';
import { annotationCardBase } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import { readCommentDraft } from '@/lib/commentDrafts';
import type { CommentReaction } from '@/lib/reactions';
import type { PullReviewComment, ThreadCommentMetadata } from '@/lib/types';

interface ThreadAnnotationProps {
  annotation: DiffLineAnnotation<ThreadCommentMetadata>;
  itemId: string;
  // Whether a token is saved, i.e. replies/edits can be attempted at all.
  canWrite: boolean;
  onDeleteComment(
    itemId: string,
    key: string,
    commentId: number
  ): Promise<void>;
  onEditComment(
    itemId: string,
    key: string,
    commentId: number,
    body: string
  ): Promise<void>;
  onReply(itemId: string, key: string, body: string): Promise<void>;
  // What suggestion fences in this thread replace and whether they can be
  // committed; null when the thread has none or they can't be shown as diffs.
  suggestionTarget?: SuggestionTarget | null;
  // Keeps a comment's reaction tallies on the thread after a toggle, so a
  // remounted card shows them.
  onReactionsChange?(
    itemId: string,
    key: string,
    commentId: number,
    reactions: readonly CommentReaction[]
  ): void;
}

// A GitHub review conversation rendered inline in the diff: every comment in
// the thread with author identity and age, own-comment edit/delete controls,
// and a reply composer that posts back to the pull request.
export const ThreadAnnotation = memo(function ThreadAnnotation({
  annotation,
  itemId,
  canWrite,
  onDeleteComment,
  onEditComment,
  onReply,
  suggestionTarget = null,
  onReactionsChange,
}: ThreadAnnotationProps) {
  const { key, thread } = annotation.metadata;
  const githubUser = useGitHubUser();

  return (
    <SuggestionTargetContext value={suggestionTarget}>
      <div className={cn(annotationCardBase, 'flex-col gap-3')}>
        {thread.comments.map((comment) => (
          <ThreadComment
            key={comment.id}
            comment={comment}
            canModify={canWrite && githubUser?.login === comment.author.login}
            canReact={canWrite && comment.reactionsViewerUnknown !== true}
            editDraftKey={`edit:${comment.id}`}
            onDelete={() => onDeleteComment(itemId, key, comment.id)}
            onEdit={(body) => onEditComment(itemId, key, comment.id, body)}
            onReactionsChange={(reactions) =>
              onReactionsChange?.(itemId, key, comment.id, reactions)
            }
          />
        ))}
        {canWrite ? (
          <ReplyComposer
            draftKey={`reply:${itemId}:${key}`}
            onReply={(body) => onReply(itemId, key, body)}
          />
        ) : (
          <p className="text-muted-foreground m-0 text-[13px]">
            Sign in with GitHub or save a token to reply.
          </p>
        )}
      </div>
    </SuggestionTargetContext>
  );
});

interface ThreadCommentProps {
  canModify: boolean;
  canReact: boolean;
  comment: PullReviewComment;
  editDraftKey: string;
  onDelete(): Promise<void>;
  onEdit(body: string): Promise<void>;
  onReactionsChange(reactions: readonly CommentReaction[]): void;
}

function ThreadComment({
  canModify,
  canReact,
  comment,
  editDraftKey,
  onDelete,
  onEdit,
  onReactionsChange,
}: ThreadCommentProps) {
  // Reopen an edit that was in progress when the card scrolled away.
  const [hadEditDraft] = useState(
    () => canModify && readCommentDraft(editDraftKey) != null
  );
  const moderation = useCommentModeration(onDelete, hadEditDraft);
  const showActions =
    comment.htmlUrl != null || (canModify && !moderation.isEditing);

  return (
    <div className="group/comment flex gap-2.5">
      <CommentAuthorAvatar author={comment.author} className="size-6" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <strong className="text-[13px]">{comment.author.login}</strong>
          <RelativeTime
            className="text-muted-foreground text-[12px]"
            iso={comment.createdAt}
          />
          {showActions && (
            <span className="ml-auto flex gap-1 opacity-0 transition-opacity duration-100 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100">
              {comment.htmlUrl != null && (
                <Button
                  asChild
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open comment on GitHub"
                >
                  <a
                    href={comment.htmlUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                    title="Open comment on GitHub"
                  >
                    <IconArrowUpRight size={12} />
                  </a>
                </Button>
              )}
              {canModify && !moderation.isEditing && (
                <CommentModerationButtons moderation={moderation} />
              )}
            </span>
          )}
        </div>
        {moderation.isEditing ? (
          <CommentEditComposer
            autoFocus={!hadEditDraft}
            draftKey={editDraftKey}
            initialBody={comment.body}
            moderation={moderation}
            onEdit={onEdit}
          />
        ) : (
          <DeferredMarkdownContent flavor="comment" markdown={comment.body} />
        )}
        {!moderation.isEditing && (
          <CommentReactions
            canReact={canReact}
            nodeId={comment.nodeId}
            reactions={comment.reactions}
            onChange={onReactionsChange}
          />
        )}
        {moderation.isConfirmingDelete && (
          <CommentDeleteConfirm moderation={moderation} />
        )}
      </div>
    </div>
  );
}

interface ReplyComposerProps {
  draftKey: string;
  onReply(body: string): Promise<void>;
}

// Collapsed to a "Reply…" field; opens directly when a draft is stored.
function ReplyComposer({ draftKey, onReply }: ReplyComposerProps) {
  const [isOpen, setIsOpen] = useState(
    () => readCommentDraft(draftKey) != null
  );
  // Autofocus only when user-opened; restored composers must not steal focus.
  const [openedByUser, setOpenedByUser] = useState(false);

  if (!isOpen) {
    return (
      <button
        type="button"
        className="text-muted-foreground hover:border-foreground/30 hover:text-foreground w-full cursor-text rounded-md border border-[var(--diffshub-annotation-border,var(--color-border))] px-3 py-1.5 text-left text-[13px] transition-colors"
        onClick={() => {
          setOpenedByUser(true);
          setIsOpen(true);
        }}
      >
        Reply…
      </button>
    );
  }

  return (
    <CommentComposer
      autoFocus={openedByUser}
      draftKey={draftKey}
      placeholder="Write a reply…"
      submitLabel="Reply"
      onCancel={() => setIsOpen(false)}
      onSubmit={async (body) => {
        await onReply(body);
        setIsOpen(false);
      }}
    />
  );
}
