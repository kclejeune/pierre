'use client';

import { useRef, useState } from 'react';

import { InlineConfirm } from './InlineConfirm';
import { MarkdownEditor } from './MarkdownEditor';
import { Button } from '@/components/Button';
import {
  clearCommentDraft,
  readCommentDraft,
  writeCommentDraft,
} from '@/lib/commentDrafts';

interface CommentComposerProps {
  autoFocus?: boolean;
  // Keeps unsent text across unmounts (virtualized cards). Cleared on submit or
  // discard.
  draftKey?: string;
  initialBody?: string;
  pendingLabel?: string;
  placeholder?: string;
  submitLabel: string;
  onCancel(): void;
  // May reject to signal a failed submit (already surfaced to the user); the
  // composer stays open with the draft intact in that case.
  onSubmit(body: string): void | Promise<void>;
}

// Markdown composer with submit/cancel for replies, edits, and new comments.
// Escape asks before discarding typed text.
export function CommentComposer({
  autoFocus = false,
  draftKey,
  initialBody = '',
  pendingLabel = 'Posting…',
  placeholder = 'Leave a comment…',
  submitLabel,
  onCancel,
  onSubmit,
}: CommentComposerProps) {
  const [body, setBody] = useState(
    () =>
      (draftKey != null ? readCommentDraft(draftKey) : undefined) ?? initialBody
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmedBody = body.trim();
  const isDirty = trimmedBody !== initialBody.trim();
  const canSubmit = !isSubmitting && trimmedBody !== '' && isDirty;

  function updateBody(next: string) {
    setBody(next);
    if (draftKey != null) {
      writeCommentDraft(draftKey, next === initialBody ? '' : next);
    }
  }

  function discard() {
    if (draftKey != null) {
      clearCommentDraft(draftKey);
    }
    onCancel();
  }

  function requestCancel() {
    if (isSubmitting) {
      return;
    }
    if (isDirty && trimmedBody !== '') {
      setIsConfirmingDiscard(true);
      return;
    }
    discard();
  }

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onSubmit(trimmedBody);
      if (draftKey != null) {
        clearCommentDraft(draftKey);
      }
    } catch {
      // The submit handler surfaces its own error; keep the draft editable.
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <MarkdownEditor
        textareaRef={textareaRef}
        autoFocus={autoFocus}
        disabled={isSubmitting}
        placeholder={placeholder}
        value={body}
        onCancel={requestCancel}
        onChange={updateBody}
        onSubmit={() => void submit()}
      />
      {isConfirmingDiscard ? (
        <InlineConfirm
          confirmLabel="Discard"
          message="Discard what you wrote?"
          onCancel={() => {
            setIsConfirmingDiscard(false);
            textareaRef.current?.focus({ preventScroll: true });
          }}
          onConfirm={discard}
        />
      ) : (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="muted"
            size="sm"
            disabled={isSubmitting}
            onClick={requestCancel}
            className="text-muted-foreground hover:text-foreground font-normal hover:no-underline"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="default"
            size="sm"
            disabled={!canSubmit}
            className="bg-blue-500 hover:bg-blue-600"
          >
            {isSubmitting ? pendingLabel : submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
