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
import { DeferredMarkdownContent } from './MarkdownContent';
import { useGitHubUser } from './useGitHubUser';
import { Button } from '@/components/Button';
import { annotationCardBase } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
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
}: ThreadAnnotationProps) {
  const { key, thread } = annotation.metadata;
  const githubUser = useGitHubUser();

  return (
    <div className={cn(annotationCardBase, 'flex-col gap-3')}>
      {thread.comments.map((comment) => (
        <ThreadComment
          key={comment.id}
          comment={comment}
          canModify={canWrite && githubUser?.login === comment.author.login}
          onDelete={() => onDeleteComment(itemId, key, comment.id)}
          onEdit={(body) => onEditComment(itemId, key, comment.id, body)}
        />
      ))}
      {canWrite ? (
        <ReplyComposer onReply={(body) => onReply(itemId, key, body)} />
      ) : (
        <p className="text-muted-foreground m-0 text-[13px]">
          Sign in with GitHub or save a token to reply.
        </p>
      )}
    </div>
  );
});

interface ThreadCommentProps {
  canModify: boolean;
  comment: PullReviewComment;
  onDelete(): Promise<void>;
  onEdit(body: string): Promise<void>;
}

function ThreadComment({
  canModify,
  comment,
  onDelete,
  onEdit,
}: ThreadCommentProps) {
  const moderation = useCommentModeration(onDelete);
  const showActions =
    comment.htmlUrl != null || (canModify && !moderation.isEditing);

  return (
    <div className="group/comment flex gap-2.5">
      <CommentAuthorAvatar author={comment.author} className="size-6" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <strong className="text-[13px]">{comment.author.login}</strong>
          <span className="text-muted-foreground text-[12px]">
            {formatRelativeTime(comment.createdAt)}
          </span>
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
            initialBody={comment.body}
            moderation={moderation}
            onEdit={onEdit}
          />
        ) : (
          <DeferredMarkdownContent markdown={comment.body} />
        )}
        {moderation.isConfirmingDelete && (
          <CommentDeleteConfirm moderation={moderation} />
        )}
      </div>
    </div>
  );
}

interface ReplyComposerProps {
  onReply(body: string): Promise<void>;
}

function ReplyComposer({ onReply }: ReplyComposerProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!isOpen) {
    return (
      <button
        type="button"
        className="text-muted-foreground hover:border-foreground/30 hover:text-foreground w-full cursor-text rounded-md border border-[var(--diffshub-annotation-border,var(--color-border))] px-3 py-1.5 text-left text-[13px] transition-colors"
        onClick={() => setIsOpen(true)}
      >
        Reply…
      </button>
    );
  }

  return (
    <CommentComposer
      autoFocus
      submitLabel="Reply"
      onCancel={() => setIsOpen(false)}
      onSubmit={async (body) => {
        await onReply(body);
        setIsOpen(false);
      }}
    />
  );
}
