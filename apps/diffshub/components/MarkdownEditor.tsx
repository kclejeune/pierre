'use client';

import {
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
  useRef,
  useState,
} from 'react';

import { MarkdownContent } from './MarkdownContent';
import { cn } from '@/lib/cn';
import {
  formatSelection,
  isPastedURL,
  linkSelectionTo,
  type MarkdownEdit,
  type MarkdownFormat,
} from '@/lib/markdownEditing';

const FORMAT_SHORTCUTS: Record<string, MarkdownFormat> = {
  b: 'bold',
  e: 'code',
  i: 'italic',
  k: 'link',
};

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad/i.test(navigator.platform);

const SUBMIT_SHORTCUT_LABEL = IS_MAC ? '⌘↵' : 'Ctrl+↵';

// Cmd/Ctrl+Enter, plus Shift+Enter, which the inline composers always accepted.
function isSubmitChord(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.shiftKey)
  );
}

// Edits through execCommand so they join the undo stack and fire input events.
// The setRangeText fallback skips undo.
function applyEdit(textarea: HTMLTextAreaElement, edit: MarkdownEdit): void {
  const start = textarea.selectionStart;
  textarea.focus();
  const inserted =
    typeof document.execCommand === 'function' &&
    document.execCommand('insertText', false, edit.replacement);
  if (!inserted) {
    textarea.setRangeText(edit.replacement);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  textarea.setSelectionRange(
    start + edit.selectionStart,
    start + edit.selectionEnd
  );
}

interface MarkdownEditorProps {
  autoFocus?: boolean;
  // 'bare' for cards that already frame the field.
  appearance?: 'bordered' | 'bare';
  'aria-label'?: string;
  disabled?: boolean;
  textareaClassName?: string;
  placeholder?: string;
  rows?: number;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onCancel?(): void;
  onChange(value: string): void;
  // Keydowns the editor doesn't handle, e.g. to block Radix typeahead.
  onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onSubmit?(): void;
}

// The shared markdown field: Write/Preview, GitHub's formatting shortcuts
// (Cmd/Ctrl+B/I/E/K; paste a URL over a selection to link it), the submit
// chord, and Escape to cancel.
export function MarkdownEditor({
  appearance = 'bordered',
  'aria-label': ariaLabel,
  autoFocus = false,
  disabled = false,
  onCancel,
  onChange,
  onKeyDown,
  onSubmit,
  placeholder,
  rows = 2,
  textareaClassName,
  textareaRef: externalTextareaRef,
  value,
}: MarkdownEditorProps) {
  const [previewing, setPreviewing] = useState(false);
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && onCancel != null) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (isSubmitChord(event) && onSubmit != null) {
      event.preventDefault();
      onSubmit();
      return;
    }
    const format =
      (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
        ? FORMAT_SHORTCUTS[event.key.toLowerCase()]
        : undefined;
    if (format != null) {
      event.preventDefault();
      const textarea = event.currentTarget;
      const selected = textarea.value.slice(
        textarea.selectionStart,
        textarea.selectionEnd
      );
      applyEdit(textarea, formatSelection(selected, format));
      return;
    }
    onKeyDown?.(event);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    const pasted = event.clipboardData.getData('text/plain').trim();
    const selected = textarea.value.slice(
      textarea.selectionStart,
      textarea.selectionEnd
    );
    if (selected === '' || selected.includes('\n') || !isPastedURL(pasted)) {
      return;
    }
    event.preventDefault();
    applyEdit(textarea, linkSelectionTo(selected, pasted));
  }

  const bordered = appearance === 'bordered';
  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col',
        bordered &&
          'rounded-md border border-[var(--diffshub-annotation-border,var(--color-border))] focus-within:border-[color-mix(in_srgb,currentColor_35%,transparent)]'
      )}
    >
      {previewing ? (
        <div
          className={cn(
            'min-h-[3.75rem] w-full',
            bordered ? 'px-3 py-1.5' : 'py-1.5'
          )}
        >
          {value.trim() === '' ? (
            <p className="text-muted-foreground m-0 text-[13px]">
              Nothing to preview yet.
            </p>
          ) : (
            <MarkdownContent flavor="comment" markdown={value} />
          )}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          rows={rows}
          value={value}
          className={cn(
            'field-sizing-content w-full resize-none bg-transparent py-1.5 text-[14px] text-inherit placeholder:text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] focus:outline-none',
            bordered ? 'px-3' : 'rounded-sm',
            textareaClassName
          )}
          onChange={({ currentTarget }) => onChange(currentTarget.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
      )}
      <div
        className={cn(
          'text-muted-foreground flex items-center gap-2 text-[11px]',
          bordered
            ? 'border-t border-[var(--diffshub-annotation-border,var(--color-border))] px-1.5 py-0.5'
            : 'pt-0.5'
        )}
      >
        <button
          type="button"
          aria-pressed={previewing}
          disabled={disabled}
          className="hover:text-foreground focus-visible:ring-ring rounded px-1.5 py-0.5 font-medium outline-none focus-visible:ring-2 disabled:opacity-50 aria-pressed:text-[var(--diffshub-annotation-fg,var(--color-foreground))]"
          onClick={() => {
            setPreviewing((current) => !current);
            if (previewing) {
              requestAnimationFrame(() =>
                textareaRef.current?.focus({ preventScroll: true })
              );
            }
          }}
        >
          {previewing ? 'Edit' : 'Preview'}
        </button>
        <span className="ml-auto truncate px-1.5">
          Markdown supported
          {onSubmit != null && ` · ${SUBMIT_SHORTCUT_LABEL} to submit`}
        </span>
      </div>
    </div>
  );
}
