'use client';

import { IconComment } from '@pierre/icons';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { Button } from './Button';
import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import type { CommentNavigation } from './useCommentNavigation';
import type { DiffsHubSavedCommentEntry } from '@/lib/types';

// The header's "3 / 12" stepper through the diff's unresolved comment
// threads (see useCommentNavigation): up for the previous thread, down for
// the next, also on p and n. Before the first step, or on a resolved thread
// picked in the sidebar, the count reads "– / 12". Renders nothing when no
// thread is unresolved.
export function CommentStepper({
  navigation,
}: {
  navigation: CommentNavigation;
}) {
  const { goNext, goPrevious, next, position, previous, total } = navigation;
  if (total === 0) {
    return null;
  }
  return (
    <div
      role="group"
      aria-label="Comment navigation"
      className="text-muted-foreground flex shrink-0 items-center text-xs tabular-nums"
    >
      <StepButton direction="Previous" target={previous} onClick={goPrevious} />
      <span
        className="flex items-center gap-1 px-0.5"
        aria-live="polite"
        aria-label={
          position === -1
            ? `${total} unresolved comments`
            : `Unresolved comment ${position + 1} of ${total}`
        }
      >
        <IconComment aria-hidden className="size-3" />
        {position === -1 ? '–' : position + 1} / {total}
      </span>
      <StepButton direction="Next" target={next} onClick={goNext} />
    </div>
  );
}

// One arrow of the stepper. Its tooltip names whose comment the step lands
// on and where, or says the list ends in that direction.
function StepButton({
  direction,
  target,
  onClick,
}: {
  direction: 'Previous' | 'Next';
  target: DiffsHubSavedCommentEntry | undefined;
  onClick: () => void;
}) {
  const [Icon, shortcut, end] =
    direction === 'Previous'
      ? [ChevronUp, 'p', 'earlier']
      : [ChevronDown, 'n', 'later'];
  let title = `No ${end} unresolved comment`;
  if (target != null) {
    const where =
      target.lineType === 'file' ? 'on the file' : `line ${target.lineNumber}`;
    title = `${direction}: @${target.author.login}, ${where} (${shortcut})`;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-md"
      disabled={target == null}
      title={title}
      aria-label={`${direction} comment`}
      className={CHROME_ICON_BUTTON_CLASS}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}
