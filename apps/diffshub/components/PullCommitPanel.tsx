'use client';

import { IconBin } from '@pierre/icons';
import { useMemo, useState } from 'react';

import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { useChromeThemeProps } from './useChromeThemeProps';
import type { PullEditSession } from './usePullEditSession';
import { Button } from '@/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/DropdownMenu';
import { cn } from '@/lib/cn';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';
import { getDropdownThemeStyle } from '@/lib/theme/dropdownChromeStyle';

interface PullCommitPanelProps {
  editSession: PullEditSession;
  // Comments batched into the in-progress review; edits shift line numbers,
  // so pending drafts on edited files may anchor to old positions.
  pendingReviewCount: number;
  // Scrolls the viewer to the file so "which file is this?" is one click.
  onSelectFile(itemId: string): void;
}

// The header's "Commit" control, the write-side sibling of the Review
// control: lists files with uncommitted editor changes, offers per-file
// discard, and commits the batch to the pull request's head branch with one
// message.
export function PullCommitPanel({
  editSession,
  pendingReviewCount,
  onSelectFile,
}: PullCommitPanelProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const { style: chromeStyle } = useChromeThemeProps(diffshubChromeMapping);
  const dropdownThemeStyle = useMemo(
    () =>
      getDropdownThemeStyle(
        Object.keys(chromeStyle).length > 0 ? chromeStyle : undefined
      ),
    [chromeStyle]
  );

  const { defaultMessage, dirtyFiles, isCommitting } = editSession;
  const canSubmit = !isCommitting && dirtyFiles.length > 0;

  async function submit() {
    if (!canSubmit) {
      return;
    }
    try {
      await editSession.commit(
        message.trim() === '' ? defaultMessage : message.trim()
      );
      setMessage('');
      setOpen(false);
    } catch {
      // Failure already surfaced via toast; keep the panel open.
    }
  }

  if (dirtyFiles.length === 0) {
    return null;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title="Commit your edits to the pull request branch"
          className={cn(CHROME_ICON_BUTTON_CLASS, 'w-auto gap-1.5 px-2')}
        >
          Commit
          <span
            aria-label={`${dirtyFiles.length} files with uncommitted edits`}
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] leading-none font-semibold text-white tabular-nums"
          >
            {dirtyFiles.length}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-96 p-3"
        style={dropdownThemeStyle}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="text-sm font-medium">Commit edits</div>
          <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
            {dirtyFiles.map((entry) => (
              <li key={entry.itemId} className="flex items-center gap-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer truncate rounded-md px-1.5 py-1 text-left font-mono text-xs hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))]"
                  title={`Jump to ${entry.path}`}
                  onClick={() => {
                    onSelectFile(entry.itemId);
                    setOpen(false);
                  }}
                >
                  {entry.path}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Discard edits to ${entry.path}`}
                  title={`Discard edits to ${entry.path}`}
                  disabled={isCommitting}
                  onClick={() => editSession.discardFile(entry.itemId)}
                >
                  <IconBin className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
          <textarea
            value={message}
            rows={2}
            disabled={isCommitting}
            placeholder={defaultMessage}
            className="field-sizing-content max-h-40 w-full resize-none rounded-md border border-[var(--diffshub-annotation-border,var(--color-border))] bg-transparent px-3 py-1.5 font-mono text-[13px] text-inherit placeholder:text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] focus:outline-none"
            onChange={({ currentTarget }) => setMessage(currentTarget.value)}
            onKeyDown={(keyEvent) => {
              keyEvent.stopPropagation();
              if (
                keyEvent.key === 'Enter' &&
                (keyEvent.metaKey || keyEvent.shiftKey)
              ) {
                keyEvent.preventDefault();
                void submit();
              }
            }}
          />
          {pendingReviewCount > 0 && (
            <p className="text-muted-foreground text-xs">
              You have {pendingReviewCount} pending review{' '}
              {pendingReviewCount === 1 ? 'comment' : 'comments'} — drafts on
              edited files may anchor to old line numbers after this commit.
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              Commits to the pull request branch
            </span>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={!canSubmit}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {isCommitting
                ? 'Committing…'
                : `Commit ${dirtyFiles.length === 1 ? '1 file' : `${dirtyFiles.length} files`}`}
            </Button>
          </div>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
