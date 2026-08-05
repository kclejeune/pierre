'use client';

import type { DiffLineAnnotation } from '@pierre/diffs';
import { IconPencil, IconX } from '@pierre/icons';
import { memo, useState } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { CommentComposer } from './CommentComposer';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { MarkdownContent } from './MarkdownContent';
import { useGitHubUser } from './useGitHubUser';
import { Button } from '@/components/Button';
import { annotationCardBase } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import type { PullReviewComment, ThreadCommentMetadata } from '@/lib/types';

interface ThreadAnnotationProps {
  annotation: DiffLineAnnotation<ThreadCommentMetadata>;
  itemId: string;
  // Whether a token is saved, i.e. replies/edits can be attempted at all.
  canWrite: boolean;
  // When set, each comment's timestamp links to the comment on GitHub.
  pullRequest?: PullRequestRef;
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
  pullRequest,
  onDeleteComment,
  onEditComment,
  onReply,
}: ThreadAnnotationProps) {
  const { key, thread } = annotation.metadata;
  const githubUser = useGitHubUser();
  const { webURL } = useGitHubEnvironment();

  return (
    <div className={cn(annotationCardBase, 'flex-col gap-3')}>
      {thread.comments.map((comment) => (
        <ThreadComment
          key={comment.id}
          comment={comment}
          canModify={canWrite && githubUser?.login === comment.author.login}
          githubUrl={
            pullRequest != null
              ? `${webURL}/${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.number}#discussion_r${comment.id}`
              : undefined
          }
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
  // Link to this comment on GitHub; rendered as the timestamp's permalink,
  // matching GitHub's own comment headers.
  githubUrl?: string;
  onDelete(): Promise<void>;
  onEdit(body: string): Promise<void>;
}

function ThreadComment({
  canModify,
  comment,
  githubUrl,
  onDelete,
  onEdit,
}: ThreadCommentProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  return (
    <div className="group/comment flex gap-2.5">
      <CommentAuthorAvatar author={comment.author} className="size-6" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <strong className="text-[13px]">{comment.author.login}</strong>
          {githubUrl != null ? (
            <a
              className="text-muted-foreground hover:text-foreground text-[12px] hover:underline"
              href={githubUrl}
              rel="noreferrer noopener"
              target="_blank"
              title="View this comment on GitHub"
            >
              {formatRelativeTime(comment.createdAt)}
            </a>
          ) : (
            <span className="text-muted-foreground text-[12px]">
              {formatRelativeTime(comment.createdAt)}
            </span>
          )}
          {canModify && !isEditing && (
            <span className="ml-auto flex gap-1 opacity-0 transition-opacity duration-100 group-hover/comment:opacity-100">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Edit comment"
                disabled={isDeleting}
                onClick={() => setIsEditing(true)}
              >
                <IconPencil size={12} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Delete comment"
                disabled={isDeleting}
                onClick={() => {
                  if (!window.confirm('Delete this comment on GitHub?')) {
                    return;
                  }
                  setIsDeleting(true);
                  onDelete().catch(() => {
                    // Failure already surfaced; re-enable the controls.
                    setIsDeleting(false);
                  });
                }}
              >
                <IconX size={12} />
              </Button>
            </span>
          )}
        </div>
        {isEditing ? (
          <CommentComposer
            autoFocus
            initialBody={comment.body}
            submitLabel="Save"
            onCancel={() => setIsEditing(false)}
            onSubmit={async (body) => {
              await onEdit(body);
              setIsEditing(false);
            }}
          />
        ) : (
          <MarkdownContent markdown={comment.body} />
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
