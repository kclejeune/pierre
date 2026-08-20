import type { DiffLineAnnotation } from '@pierre/diffs';
import { useStableCallback } from '@pierre/diffs/react';
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
  // Seeded from the annotation metadata, which is also kept in sync on every
  // keystroke: the virtualizer unmounts this card when it scrolls offscreen,
  // so the metadata (which lives on the viewer's item model) is what carries
  // the in-progress text across a remount.
  const [message, setMessage] = useState(annotation.metadata.message);
  // Comments are authored as the signed-in GitHub user when a token resolves
  // an identity; otherwise fall back to a random demo persona.
  const githubUser = useGitHubUser();
  const [personaAuthor] = useState(getRandomPersonaAuthor);
  const author: CommentAuthor = githubUser ?? personaAuthor;
  const [isSaving, setIsSaving] = useState(false);
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
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

    // Only a brand-new draft grabs focus. A non-empty mount is the virtualizer
    // recreating an in-progress card as it scrolls back into view — stealing
    // focus there would dump the user's scroll keystrokes into the textarea.
    if (textarea.value !== '') {
      return;
    }

    textarea.focus({ preventScroll: true });
    const cursorIndex = textarea.value.length;
    textarea.setSelectionRange(cursorIndex, cursorIndex);
  }, []);

  // Dismissal from outside the card. Once focus leaves the textarea (the user
  // clicked elsewhere in the diff), its own Escape handler can no longer fire,
  // so listen at the document level: Escape anywhere cancels the draft (with
  // the usual discard confirm when text is present), and a pointerdown outside
  // the card removes a still-empty draft. The card renders as slotted light-DOM
  // content inside the diff viewer's shadow tree, so composedPath() is needed
  // to decide whether an event originated inside it.
  const handleDocumentPointerDown = useStableCallback((event: PointerEvent) => {
    const form = formRef.current;
    if (form == null || event.composedPath().includes(form)) {
      return;
    }
    if (trimmedMessage.length === 0 && !isSaving) {
      onCancel(itemId, annotation.metadata.key);
    }
  });
  const handleDocumentKeyDown = useStableCallback((event: KeyboardEvent) => {
    // defaultPrevented covers both the textarea's own Escape handler and
    // overlays (dropdowns, dialogs) that consume Escape to close themselves.
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return;
    }
    tryCancel();
  });
  useEffect(() => {
    document.addEventListener('pointerdown', handleDocumentPointerDown);
    document.addEventListener('keydown', handleDocumentKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
    };
  }, [handleDocumentPointerDown, handleDocumentKeyDown]);

  return (
    <form
      ref={formRef}
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
          onChange={({ currentTarget }) => {
            annotation.metadata.message = currentTarget.value;
            setMessage(currentTarget.value);
          }}
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
