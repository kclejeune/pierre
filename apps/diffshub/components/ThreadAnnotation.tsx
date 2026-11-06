'use client';

import type { DiffLineAnnotation } from '@pierre/diffs';
import { IconCheck, IconChevronSm } from '@pierre/icons';
import {
  createContext,
  memo,
  type RefObject,
  use,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { CommentHeaderActions, CommentTimestamp } from './CommentActions';
import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import {
  CommentComposer,
  type CommentComposerHandle,
  ComposerTrigger,
} from './CommentComposer';
import {
  CommentDeleteConfirm,
  CommentEditComposer,
  useCommentModeration,
} from './CommentModeration';
import { ReactionChipList, useCommentReactions } from './CommentReactions';
import {
  DeferredMarkdownContent,
  type SuggestionTarget,
  SuggestionTargetContext,
} from './MarkdownContent';
import { useGitHubUser } from './useGitHubUser';
import { Button } from '@/components/Button';
import { annotationCardBase } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import { readCommentDraft, writeCommentDraft } from '@/lib/commentDrafts';
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
  // Marks the thread resolved (or open again) on GitHub. Rejects, after
  // surfacing the error, when GitHub refuses.
  onResolve?(itemId: string, key: string, resolved: boolean): Promise<void>;
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

// Resolved threads the reader expanded, by `itemId:key`. Kept above the cards
// because the virtualized diff unmounts them offscreen, and an expanded
// thread should not snap shut when scrolled back to. The viewer provides one
// set per diff load; without a provider, expansion lasts the card's mount.
export const ExpandedThreadsContext = createContext<Set<string> | null>(null);

// A GitHub review conversation rendered inline in the diff, laid out like
// GitHub's own review threads: comments stacked on a rail that joins their
// avatars, per-comment badge, reaction, and overflow-menu controls in the
// header, and a footer strip with the reply bar and the resolve button.
// Resolved threads collapse to a one-line bar that expands on click.
export const ThreadAnnotation = memo(function ThreadAnnotation({
  annotation,
  itemId,
  canWrite,
  onDeleteComment,
  onEditComment,
  onReply,
  onResolve,
  suggestionTarget = null,
  onReactionsChange,
}: ThreadAnnotationProps) {
  const { key, thread } = annotation.metadata;
  const githubUser = useGitHubUser();
  const reply = useReplyComposerState(`reply:${itemId}:${key}`);
  const expandedThreads = use(ExpandedThreadsContext);
  const expandKey = `${itemId}:${key}`;
  const [expanded, setExpandedState] = useState(
    () => expandedThreads?.has(expandKey) === true
  );
  const setExpanded = (next: boolean) => {
    if (next) {
      expandedThreads?.add(expandKey);
    } else {
      expandedThreads?.delete(expandKey);
    }
    setExpandedState(next);
  };
  const [isResolving, setIsResolving] = useState(false);
  const state = thread.state;
  const isResolved = state?.isResolved === true;
  const showBody = !isResolved || expanded;

  // The resolve/unresolve toggle shows when GitHub says the viewer may use it.
  const canToggleResolved =
    canWrite &&
    onResolve != null &&
    state != null &&
    (isResolved ? state.viewerCanUnresolve : state.viewerCanResolve);
  const [resolveLabel, resolvingLabel] = isResolved
    ? ['Unresolve conversation', 'Unresolving…']
    : ['Resolve conversation', 'Resolving…'];

  const toggleResolved = (resolved: boolean) => {
    setIsResolving(true);
    onResolve?.(itemId, key, resolved)
      .then(
        () => {
          // GitHub collapses a conversation as it is resolved.
          if (resolved) {
            setExpanded(false);
          }
        },
        () => {
          // Already surfaced; the button re-enables below.
        }
      )
      .finally(() => setIsResolving(false));
  };

  return (
    <SuggestionTargetContext value={suggestionTarget}>
      <div
        className={cn(annotationCardBase, 'flex-col gap-0 overflow-hidden p-0')}
      >
        {isResolved && (
          <ResolvedBar
            commentCount={thread.comments.length}
            expanded={expanded}
            resolvedBy={state?.resolvedBy ?? null}
            onToggle={() => setExpanded(!expanded)}
          />
        )}
        {showBody && (
          <>
            <ol className="m-0 list-none px-3 pt-3 pb-1">
              {thread.comments.map((comment, index) => (
                <ThreadComment
                  key={comment.id}
                  comment={comment}
                  canModify={
                    canWrite && githubUser?.login === comment.author.login
                  }
                  canReact={canWrite && comment.reactionsViewerUnknown !== true}
                  editDraftKey={`edit:${comment.id}`}
                  hasNext={index < thread.comments.length - 1}
                  onDelete={() => onDeleteComment(itemId, key, comment.id)}
                  onEdit={(body) =>
                    onEditComment(itemId, key, comment.id, body)
                  }
                  onQuoteReply={
                    canWrite ? () => reply.quote(comment.body) : undefined
                  }
                  onReactionsChange={(reactions) =>
                    onReactionsChange?.(itemId, key, comment.id, reactions)
                  }
                />
              ))}
            </ol>
            <div className="flex flex-col gap-2.5 border-t border-[var(--diffshub-annotation-border,var(--color-border))] bg-black/[0.025] px-3 py-2.5 dark:bg-white/[0.025]">
              <div className="flex items-start gap-2.5">
                {canWrite ? (
                  <>
                    {githubUser != null && (
                      <CommentAuthorAvatar
                        author={githubUser}
                        className="mt-[3px] size-6"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <ReplyComposer
                        state={reply}
                        onReply={(body) => onReply(itemId, key, body)}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-muted-foreground m-0 text-[13px]">
                    Sign in with GitHub or save a token to reply.
                  </p>
                )}
              </div>
              {canToggleResolved && (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-[12px] font-medium"
                    disabled={isResolving}
                    onClick={() => toggleResolved(!isResolved)}
                  >
                    {isResolving ? resolvingLabel : resolveLabel}
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </SuggestionTargetContext>
  );
});

// The header row of a resolved thread: who resolved it and a toggle that
// shows or hides the conversation (collapsed by default, as on GitHub).
function ResolvedBar({
  commentCount,
  expanded,
  onToggle,
  resolvedBy,
}: {
  commentCount: number;
  expanded: boolean;
  onToggle(): void;
  resolvedBy: string | null;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className={cn(
        'text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset',
        expanded &&
          'border-b border-[var(--diffshub-annotation-border,var(--color-border))]'
      )}
      onClick={onToggle}
    >
      <IconCheck size={14} className="shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        {resolvedBy != null ? (
          <>
            <strong className="text-foreground font-semibold">
              {resolvedBy}
            </strong>{' '}
            marked this conversation as resolved
          </>
        ) : (
          'This conversation was marked as resolved'
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px]">
        {expanded
          ? 'Hide'
          : `Show ${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}`}
        <IconChevronSm
          aria-hidden
          className={cn(
            'size-4 transition-transform',
            !expanded && '-rotate-90'
          )}
        />
      </span>
    </button>
  );
}

interface ThreadCommentProps {
  canModify: boolean;
  canReact: boolean;
  comment: PullReviewComment;
  editDraftKey: string;
  // Whether another comment follows, so the avatar rail continues below.
  hasNext: boolean;
  onDelete(): Promise<void>;
  onEdit(body: string): Promise<void>;
  // Unset when the viewer can't reply.
  onQuoteReply?(): void;
  onReactionsChange(reactions: readonly CommentReaction[]): void;
}

function ThreadComment({
  canModify,
  canReact,
  comment,
  editDraftKey,
  hasNext,
  onDelete,
  onEdit,
  onQuoteReply,
  onReactionsChange,
}: ThreadCommentProps) {
  // Reopen an edit that was in progress when the card scrolled away.
  const [hadEditDraft] = useState(
    () => canModify && readCommentDraft(editDraftKey) != null
  );
  const moderation = useCommentModeration(onDelete, hadEditDraft);
  const reactions = useCommentReactions({
    canReact,
    nodeId: comment.nodeId,
    reactions: comment.reactions,
    onChange: onReactionsChange,
  });

  return (
    <li className="relative flex gap-2.5 pb-4 last:pb-3">
      {hasNext && (
        <span
          aria-hidden
          className="absolute top-7 bottom-0 left-3 w-0.5 -translate-x-1/2 rounded-full bg-[var(--diffshub-annotation-border,var(--color-border))]"
        />
      )}
      <CommentAuthorAvatar author={comment.author} className="size-6" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-6 items-center gap-1.5">
          <strong className="truncate text-[13px] font-semibold">
            {comment.author.login}
          </strong>
          <CommentTimestamp htmlUrl={comment.htmlUrl} iso={comment.createdAt} />
          <CommentHeaderActions
            authorLogin={comment.author.login}
            editing={moderation.isEditing}
            menu={{
              canModify,
              htmlUrl: comment.htmlUrl,
              moderation,
              onQuoteReply,
            }}
            reactions={reactions}
          />
        </div>
        {moderation.isEditing ? (
          <div className="mt-1">
            <CommentEditComposer
              autoFocus={!hadEditDraft}
              draftKey={editDraftKey}
              initialBody={comment.body}
              moderation={moderation}
              onEdit={onEdit}
            />
          </div>
        ) : (
          <DeferredMarkdownContent
            className="mt-0.5"
            flavor="comment"
            markdown={comment.body}
          />
        )}
        {!moderation.isEditing && (
          <ReactionChipList className="mt-2" state={reactions} />
        )}
        {moderation.isConfirmingDelete && (
          <div className="mt-2">
            <CommentDeleteConfirm moderation={moderation} />
          </div>
        )}
      </div>
    </li>
  );
}

// Open/closed state for a thread's reply composer, owned by the thread so
// "Quote reply" in any comment's menu can open it pre-filled. The composer
// starts open when a draft is stored. A quote goes into the open composer
// through its handle, or into the draft it will mount with.
interface ReplyComposerState {
  composerRef: RefObject<CommentComposerHandle | null>;
  draftKey: string;
  isOpen: boolean;
  // Autofocus only when user-opened; restored composers must not steal focus.
  openedByUser: boolean;
  close(): void;
  open(): void;
  quote(body: string): void;
}

function useReplyComposerState(draftKey: string): ReplyComposerState {
  const [isOpen, setIsOpen] = useState(
    () => readCommentDraft(draftKey) != null
  );
  const [openedByUser, setOpenedByUser] = useState(false);
  const composerRef = useRef<CommentComposerHandle>(null);
  const open = () => {
    setOpenedByUser(true);
    setIsOpen(true);
  };
  return {
    composerRef,
    draftKey,
    isOpen,
    openedByUser,
    close: () => setIsOpen(false),
    open,
    quote: (body) => {
      const quoted = `${body
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n')}\n\n`;
      const composer = composerRef.current;
      if (composer != null) {
        if (!composer.append(quoted)) {
          toast('Your reply is still posting. Quote again once it posts.');
        }
        return;
      }
      const existing = readCommentDraft(draftKey)?.trimEnd() ?? '';
      writeCommentDraft(
        draftKey,
        existing === '' ? quoted : `${existing}\n\n${quoted}`
      );
      open();
    },
  };
}

interface ReplyComposerProps {
  state: ReplyComposerState;
  onReply(body: string): Promise<void>;
}

// Collapsed to a "Reply…" field until clicked (or a draft/quote opens it).
function ReplyComposer({ state, onReply }: ReplyComposerProps) {
  if (!state.isOpen) {
    return (
      <ComposerTrigger
        className="border-[var(--diffshub-annotation-border,var(--color-border))] bg-[var(--diffshub-annotation-bg,var(--color-card))]"
        label="Reply…"
        onOpen={state.open}
      />
    );
  }

  return (
    <CommentComposer
      ref={state.composerRef}
      autoFocus={state.openedByUser}
      draftKey={state.draftKey}
      placeholder="Write a reply…"
      submitLabel="Reply"
      onCancel={state.close}
      onSubmit={async (body) => {
        await onReply(body);
        state.close();
      }}
    />
  );
}
