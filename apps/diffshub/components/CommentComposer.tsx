'use client';

import { useState } from 'react';

import { Button } from '@/components/Button';

interface CommentComposerProps {
  autoFocus?: boolean;
  busy?: boolean;
  initialBody?: string;
  submitLabel: string;
  onCancel(): void;
  // May reject to signal a failed submit (already surfaced to the user); the
  // composer stays open with the draft intact in that case.
  onSubmit(body: string): void | Promise<void>;
}

// Shared textarea + submit/cancel row used by thread replies and comment
// editing. Submit on Cmd/Shift+Enter, cancel on Escape.
export function CommentComposer({
  autoFocus = false,
  busy = false,
  initialBody = '',
  submitLabel,
  onCancel,
  onSubmit,
}: CommentComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isBusy = busy || isSubmitting;
  const trimmedBody = body.trim();
  const canSubmit =
    !isBusy && trimmedBody !== '' && trimmedBody !== initialBody.trim();

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onSubmit(trimmedBody);
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
      <textarea
        autoFocus={autoFocus}
        value={body}
        disabled={isBusy}
        rows={2}
        placeholder="Leave a comment…"
        className="field-sizing-content w-full resize-none rounded-md border border-[var(--diffshub-annotation-border,var(--color-border))] bg-transparent px-3 py-1.5 text-[14px] text-inherit placeholder:text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] focus:outline-none"
        onChange={({ currentTarget }) => setBody(currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key === 'Enter' && (event.metaKey || event.shiftKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="muted"
          size="sm"
          disabled={isBusy}
          onClick={onCancel}
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
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
