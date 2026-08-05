'use client';

import { Button } from '@/components/Button';

interface InlineConfirmProps {
  // Disables both buttons, e.g. while the confirmed action is in flight.
  disabled?: boolean;
  confirmLabel: string;
  message: string;
  onCancel(): void;
  onConfirm(): void;
}

// In-card replacement for window.confirm: a compact prompt row with a
// destructive confirm button, styled to sit inside annotation cards so
// destructive actions (delete comment, discard draft) keep the app's look
// instead of the browser-native dialog.
export function InlineConfirm({
  disabled = false,
  confirmLabel,
  message,
  onCancel,
  onConfirm,
}: InlineConfirmProps) {
  return (
    <div className="border-border bg-muted/40 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5">
      <span className="text-[13px]">{message}</span>
      <span className="ml-auto flex gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="xs"
          autoFocus
          disabled={disabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </span>
    </div>
  );
}
