'use client';

import { IconCheck, IconPlus } from '@pierre/icons';
import { type ReactNode, useState } from 'react';

import { Button } from './Button';
import { Input } from './Input';
import { PanelSectionSlot } from './PanelSection';
import { annotationBorderColor } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import { toastError } from '@/lib/toastRequestError';

// Shared pieces of the pull details panel's editable sidebar sections
// (Labels, Reviewers): open/filter/pending state, the heading's Edit / Add
// toggle, the fixed-height empty line, and the search-and-toggle picker.
// Layout shared with the preview skeleton lives in PanelSection.

// The picker's state, plus `run`, which applies one change at a time: it
// skips while another is pending or without a token, and toasts failures.
export function usePanelPicker(getGitHubToken: () => string | undefined) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  async function run(
    key: string,
    change: (token: string) => Promise<void>,
    failureMessage: string
  ) {
    const token = getGitHubToken();
    if (token == null || token === '' || pending != null) {
      return;
    }
    setPending(key);
    try {
      await change(token);
    } catch (error) {
      toastError(error, failureMessage);
    } finally {
      setPending(null);
    }
  }
  return {
    filter,
    open,
    pending,
    run,
    setFilter,
    toggle() {
      setOpen(!open);
      setFilter('');
    },
  };
}

// Opens and closes the picker. With items it's a quiet "Edit" in the
// heading; with none it's an outlined "Add …" where the items would be.
export function PanelPickerToggle({
  addLabel,
  empty,
  onToggle,
  open,
}: {
  addLabel: string;
  empty: boolean;
  onToggle(): void;
  open: boolean;
}) {
  return (
    <Button
      type="button"
      variant={empty ? 'outline' : 'ghost'}
      size="xs"
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? (
        'Done'
      ) : empty ? (
        <>
          <IconPlus className="size-3" />
          {addLabel}
        </>
      ) : (
        'Edit'
      )}
    </Button>
  );
}

// An empty section's line: the Add toggle when the viewer can edit,
// otherwise a note (pulsing while what it depends on loads), all at the
// toggle's height so the section keeps its size as permissions load.
export function PanelEmptyLine({
  emptyText,
  loading,
  loadingText,
  toggle,
}: {
  emptyText: string;
  loading: boolean;
  loadingText: string;
  toggle: ReactNode;
}) {
  return (
    <PanelSectionSlot>
      {toggle ?? (
        <p
          className={cn(
            'text-muted-foreground text-xs',
            loading && 'animate-pulse'
          )}
        >
          {loading ? loadingText : emptyText}
        </p>
      )}
    </PanelSectionSlot>
  );
}

// What the picker shows instead of options: loading, a failure, or no
// matches.
export type PanelPickerMessage = {
  kind: 'error' | 'loading' | 'note';
  text: string;
} | null;

// The open picker: a search box over either `message` or the `children`
// options. Enter calls `onEnter` (typically: apply the top match), which
// returns whether it applied anything; only then is the search cleared, so
// Enter before results arrive keeps the text.
export function PanelPicker({
  ariaLabel,
  children,
  filter,
  message,
  onEnter,
  onFilterChange,
  placeholder,
}: {
  ariaLabel: string;
  children: ReactNode;
  filter: string;
  message: PanelPickerMessage;
  onEnter(): boolean;
  onFilterChange(filter: string): void;
  placeholder: string;
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-md border ${annotationBorderColor} p-1.5`}
    >
      <Input
        inputSize="sm"
        value={filter}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus
        onChange={({ currentTarget }) => onFilterChange(currentTarget.value)}
        onKeyDown={(keyEvent) =>
          handlePickerSearchKey(keyEvent, filter, onEnter, onFilterChange)
        }
      />
      {message == null ? (
        <ul className="flex max-h-48 flex-col overflow-y-auto">{children}</ul>
      ) : (
        <p
          className={cn(
            'px-1 text-xs',
            message.kind === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground',
            message.kind === 'loading' && 'animate-pulse'
          )}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

// The search box's keydown: it stops every key from reaching Radix's menu
// typeahead, and Enter on a non-empty search calls `onEnter`, clearing the
// search only when that applied something (so Enter before results arrive
// leaves the pending search running).
export function handlePickerSearchKey(
  keyEvent: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>,
  filter: string,
  onEnter: () => boolean,
  onFilterChange: (filter: string) => void
): void {
  keyEvent.stopPropagation();
  if (keyEvent.key === 'Enter' && filter.trim() !== '') {
    keyEvent.preventDefault();
    if (onEnter()) {
      onFilterChange('');
    }
  }
}

// One picker option: a check mark when it applies, then its content.
export function PanelPickerOption({
  checked,
  children,
  disabled,
  onSelect,
}: {
  checked: boolean;
  children: ReactNode;
  disabled: boolean;
  onSelect(): void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))] disabled:opacity-50"
        onClick={onSelect}
      >
        <IconCheck
          aria-hidden
          className={cn('size-3 shrink-0', !checked && 'invisible')}
        />
        {children}
      </button>
    </li>
  );
}
