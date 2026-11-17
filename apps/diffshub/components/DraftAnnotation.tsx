import type { DiffLineAnnotation } from '@pierre/diffs';
import { useStableCallback } from '@pierre/diffs/react';
import { useEffect, useRef, useState } from 'react';

import { InlineConfirm } from './InlineConfirm';
import {
  applyEdit,
  isComposerOverlayEvent,
  MarkdownEditor,
} from './MarkdownEditor';
import { useGitHubUser } from './useGitHubUser';
import { Button } from '@/components/Button';
import {
  annotationCardBase,
  composerSecondaryButtonClass,
  getRandomPersonaAuthor,
} from '@/lib/annotation';
import { cn } from '@/lib/cn';
import { buildSuggestionBlock } from '@/lib/suggestedChange';
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
  // The head-side lines the draft is anchored to, when it can carry a
  // suggested change (a pull request view, head side, lines loaded).
  suggestionLines?: readonly string[] | null;
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
  suggestionLines,
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
  const canSubmit = trimmedMessage.length > 0 && !isSaving;
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
  // default (GitHub muscle memory); otherwise a single comment. The buttons
  // pick their target explicitly.
  async function handleSave() {
    await submitWith(reviewActive ? 'review' : 'single');
  }

  // Text changes also land on the annotation metadata, which carries the
  // draft across virtualizer remounts (see the state seed above).
  function updateMessage(next: string) {
    annotation.metadata.message = next;
    setMessage(next);
  }

  // Inserts a ```suggestion fence holding the anchored lines at the cursor,
  // on its own line, and selects the lines so typing replaces them.
  function insertSuggestion() {
    const textarea = textareaRef.current;
    if (suggestionLines == null) {
      return;
    }
    const block = buildSuggestionBlock(suggestionLines);
    if (textarea == null) {
      updateMessage(message === '' ? block : `${message}\n${block}`);
      return;
    }
    const before = textarea.value.slice(0, textarea.selectionStart);
    const prefix = before === '' || before.endsWith('\n') ? '' : '\n';
    const bodyStart = prefix.length + block.indexOf('\n') + 1;
    const bodyEnd = prefix.length + block.lastIndexOf('\n');
    applyEdit(textarea, {
      replacement: `${prefix}${block}\n`,
      selectionEnd: Math.max(bodyStart, bodyEnd),
      selectionStart: bodyStart,
    });
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
    // Clicks in the editor's own overlays (the heading menu, portaled outside
    // the form) are still inside the composer.
    if (
      form == null ||
      event.composedPath().includes(form) ||
      isComposerOverlayEvent(event)
    ) {
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
      className={cn(annotationCardBase, 'flex-col')}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <MarkdownEditor
        disabled={isSaving}
        placeholder="Leave a comment"
        textareaRef={textareaRef}
        value={message}
        onCancel={tryCancel}
        onChange={updateMessage}
        onSubmit={() => void handleSave()}
        onSuggestChange={suggestionLines != null ? insertSuggestion : undefined}
      />
      {!isConfirmingDiscard && (
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={composerSecondaryButtonClass}
            disabled={isSaving}
            onClick={tryCancel}
          >
            Cancel
          </Button>
          {reviewAvailable ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={composerSecondaryButtonClass}
                disabled={!canSubmit}
                onClick={() => void submitWith('single')}
              >
                Add single comment
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={!canSubmit}
                className="bg-blue-500 hover:bg-blue-600"
                onClick={() => void submitWith('review')}
              >
                {reviewActive ? 'Add review comment' : 'Start a review'}
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={!canSubmit}
              className="bg-blue-500 hover:bg-blue-600"
            >
              Comment
            </Button>
          )}
        </div>
      )}
      {isConfirmingDiscard && (
        <div className="w-full">
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
