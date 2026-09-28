'use client';

import { useState } from 'react';

import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { MarkdownEditor } from './MarkdownEditor';
import { useDropdownChromeStyle } from './useDropdownChromeStyle';
import { useGitHubUser } from './useGitHubUser';
import { Button } from '@/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/DropdownMenu';
import { cn } from '@/lib/cn';
import type { PullReviewEvent } from '@/lib/pullCommentsClient';

const REVIEW_EVENT_OPTIONS: {
  event: PullReviewEvent;
  label: string;
  description: string;
}[] = [
  {
    event: 'COMMENT',
    label: 'Comment',
    description: 'Feedback without explicit approval.',
  },
  {
    event: 'APPROVE',
    label: 'Approve',
    description: 'Approve merging these changes.',
  },
  {
    event: 'REQUEST_CHANGES',
    label: 'Request changes',
    description: 'Changes must be addressed before merging.',
  },
];

interface ReviewSubmitControlProps {
  // GitHub rejects approve/request-changes on your own pull request, so those
  // are disabled.
  authorLogin?: string;
  // Whether a token is saved, i.e. a review can be submitted at all.
  canWrite: boolean;
  // Comments batched into the in-progress review, shown as a badge and
  // submitted together with the verdict.
  pendingCount: number;
  // Rejects on failure (already surfaced); the panel stays open with the
  // draft intact.
  onSubmit(event: PullReviewEvent, body: string): Promise<void>;
}

// The header's "Review" control, GitHub's "Finish your review" equivalent:
// shows how many comments are batched, and submits them together with a
// verdict (comment / approve / request changes) and an optional summary.
// Also usable with zero pending comments to just set a review status.
export function ReviewSubmitControl({
  authorLogin,
  canWrite,
  pendingCount,
  onSubmit,
}: ReviewSubmitControlProps) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [event, setEvent] = useState<PullReviewEvent>('COMMENT');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dropdownThemeStyle = useDropdownChromeStyle();
  const viewer = useGitHubUser();
  const isOwnPull =
    authorLogin != null && viewer != null && viewer.login === authorLogin;
  // A verdict picked before the author resolved falls back to a comment.
  const effectiveEvent = isOwnPull ? 'COMMENT' : event;

  // GitHub requires substance for a plain comment review; a verdict alone is
  // enough for approve / request changes.
  const canSubmit =
    !isSubmitting &&
    (effectiveEvent !== 'COMMENT' || body.trim() !== '' || pendingCount > 0);

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onSubmit(effectiveEvent, body.trim());
      setBody('');
      setEvent('COMMENT');
      setOpen(false);
    } catch {
      // Failure already surfaced; keep the panel open with the draft.
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canWrite}
          title={
            canWrite
              ? 'Submit a review'
              : 'Sign in with GitHub or save a token to review'
          }
          className={cn(CHROME_ICON_BUTTON_CLASS, 'w-auto gap-1.5 px-2')}
        >
          Review
          {pendingCount > 0 && (
            <span
              aria-label={`${pendingCount} pending review comments`}
              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] leading-none font-semibold text-white tabular-nums"
            >
              {pendingCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 p-3"
        style={dropdownThemeStyle}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void submit();
          }}
        >
          <div className="text-sm font-medium">Submit review</div>
          <MarkdownEditor
            aria-label="Review summary"
            disabled={isSubmitting}
            placeholder="Leave a summary… (optional)"
            rows={3}
            textareaClassName="max-h-60"
            value={body}
            onChange={setBody}
            // Block Radix typeahead and item activation.
            onKeyDown={(keyEvent) => keyEvent.stopPropagation()}
            onSubmit={() => void submit()}
          />
          <div className="flex flex-col gap-1" role="radiogroup">
            {REVIEW_EVENT_OPTIONS.map((option) => {
              const blocked = isOwnPull && option.event !== 'COMMENT';
              return (
                <label
                  key={option.event}
                  className={cn(
                    'flex items-start gap-2 rounded-md px-1.5 py-1 text-sm',
                    blocked
                      ? 'cursor-not-allowed opacity-60'
                      : 'cursor-pointer hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))]'
                  )}
                >
                  <input
                    type="radio"
                    name="diffshub-review-event"
                    className="mt-1 accent-blue-500"
                    checked={effectiveEvent === option.event}
                    disabled={isSubmitting || blocked}
                    onChange={() => setEvent(option.event)}
                  />
                  <span className="flex min-w-0 flex-col">
                    {option.label}
                    <span className="text-muted-foreground text-xs">
                      {blocked
                        ? 'Not available on your own pull request.'
                        : option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              {pendingCount === 0
                ? 'No pending comments'
                : `${pendingCount} pending ${pendingCount === 1 ? 'comment' : 'comments'}`}
            </span>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={!canSubmit}
              className="bg-blue-500 hover:bg-blue-600"
            >
              {isSubmitting ? 'Submitting…' : 'Submit review'}
            </Button>
          </div>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
