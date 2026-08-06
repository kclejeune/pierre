import type { DiffLineAnnotation } from '@pierre/diffs';
import { IconArrowRight } from '@pierre/icons';
import { useEffect, useRef, useState } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { InlineConfirm } from './InlineConfirm';
import { useGitHubUser } from './useGitHubUser';
import { Button } from '@/components/Button';
import { annotationCardBase, getRandomPersonaAuthor } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import type { CommentAuthor, DraftCommentMetadata } from '@/lib/types';

interface DraftAnnotationProps {
  annotation: DiffLineAnnotation<DraftCommentMetadata>;
  itemId: string;
  // How many comments the in-progress batched review already holds; once a
  // review is started, batching becomes the draft's primary action.
  pendingReviewCount?: number;
  // Whether batching into a review is possible at all (a PR view with a
  // saved token). When false the card keeps its single-action layout.
  reviewEnabled?: boolean;
  onCancel(itemId: string, key: string): void;
  // May reject when publishing to GitHub fails (already surfaced to the
  // user); the draft stays open with its text intact in that case.
  onSave(
    itemId: string,
    key: string,
    message: string,
    author: CommentAuthor
  ): Promise<void>;
  onSaveToReview?(
    itemId: string,
    key: string,
    message: string,
    author: CommentAuthor
  ): void | Promise<void>;
}

export function DraftAnnotation({
  annotation,
  itemId,
  pendingReviewCount = 0,
  reviewEnabled = false,
  onCancel,
  onSave,
  onSaveToReview,
}: DraftAnnotationProps) {
  const [message, setMessage] = useState(annotation.metadata.message);
  // Comments are authored as the signed-in GitHub user when a token resolves
  // an identity; otherwise fall back to a random demo persona.
  const githubUser = useGitHubUser();
  const [personaAuthor] = useState(getRandomPersonaAuthor);
  const author: CommentAuthor = githubUser ?? personaAuthor;
  const [isSaving, setIsSaving] = useState(false);
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmedMessage = message.trim();
  const reviewAvailable = reviewEnabled && onSaveToReview != null;
  const reviewActive = reviewAvailable && pendingReviewCount > 0;

  async function submitWith(target: 'single' | 'review') {
    if (trimmedMessage.length === 0 || isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      if (target === 'review' && onSaveToReview != null) {
        await onSaveToReview(
          itemId,
          annotation.metadata.key,
          trimmedMessage,
          author
        );
      } else {
        await onSave(itemId, annotation.metadata.key, trimmedMessage, author);
      }
    } catch {
      // Publish failure was surfaced already; keep the draft editable.
    } finally {
      setIsSaving(false);
    }
  }

  // Form submit / Cmd+Enter: once a review is in progress, batching is the
  // primary action (GitHub muscle memory); otherwise single comment.
  async function handleSave() {
    await submitWith(reviewActive ? 'review' : 'single');
  }

  function tryCancel() {
    if (isSaving) {
      return;
    }
    if (trimmedMessage.length > 0) {
      setIsConfirmingDiscard(true);
      return;
    }
    onCancel(itemId, annotation.metadata.key);
  }

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea == null) {
      return;
    }

    textarea.focus({ preventScroll: true });
    const cursorIndex = textarea.value.length;
    textarea.setSelectionRange(cursorIndex, cursorIndex);
  }, []);

  return (
    <form
      className={cn(annotationCardBase, 'flex-col md:flex-row md:flex-wrap')}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <div className="flex w-full gap-2.5">
        <CommentAuthorAvatar author={author} />
        <textarea
          ref={textareaRef}
          value={message}
          onChange={({ currentTarget }) => setMessage(currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              tryCancel();
              return;
            }

            if ((!event.shiftKey && !event.metaKey) || event.key !== 'Enter') {
              return;
            }

            event.preventDefault();
            void handleSave();
          }}
          placeholder="Add a comment…"
          rows={2}
          disabled={isSaving}
          className="field-sizing-content w-full resize-none rounded-sm bg-transparent py-1.5 text-[14px] text-inherit placeholder:text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] focus:outline-none"
        />
      </div>
      <div className="flex w-full flex-wrap items-center justify-between gap-3 pl-10.5 md:w-auto md:justify-end md:pl-0">
        <Button
          type="button"
          variant="muted"
          onClick={tryCancel}
          className="text-muted-foreground hover:text-foreground gap-1 font-normal hover:no-underline md:hidden"
        >
          Cancel
        </Button>
        {reviewAvailable ? (
          <span className="flex items-center gap-2">
            <Button
              type="button"
              variant="muted"
              size="sm"
              disabled={trimmedMessage.length === 0 || isSaving}
              className="text-muted-foreground hover:text-foreground font-normal hover:no-underline"
              onClick={() =>
                void submitWith(reviewActive ? 'single' : 'review')
              }
            >
              {reviewActive ? 'Add single comment' : 'Start review'}
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={trimmedMessage.length === 0 || isSaving}
              className="gap-1.5 bg-blue-500 hover:bg-blue-600"
            >
              {reviewActive ? 'Add to review' : 'Comment'}
              <IconArrowRight className="-mr-0.5 size-3" />
            </Button>
          </span>
        ) : (
          <>
            <Button
              type="submit"
              variant="default"
              size="icon-md"
              disabled={trimmedMessage.length === 0 || isSaving}
              className="hidden rounded-full bg-blue-500 hover:bg-blue-600 md:flex"
            >
              <IconArrowRight className="size-4 rotate-[-90deg]" />
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={trimmedMessage.length === 0 || isSaving}
              className="gap-1.5 bg-blue-500 hover:bg-blue-600 md:hidden"
            >
              Submit
              <IconArrowRight className="-mr-0.5 size-3" />
            </Button>
          </>
        )}
      </div>
      {isConfirmingDiscard && (
        <div className="w-full md:basis-full">
          <InlineConfirm
            confirmLabel="Discard"
            message="Discard this comment?"
            onCancel={() => {
              setIsConfirmingDiscard(false);
              textareaRef.current?.focus({ preventScroll: true });
            }}
            onConfirm={() => onCancel(itemId, annotation.metadata.key)}
          />
        </div>
      )}
    </form>
  );
}
