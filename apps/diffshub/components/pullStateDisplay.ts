import { IconBranch, IconDraft, IconMerged, IconX } from '@pierre/icons';

// A pull request's state as both the /pulls list and the pull details panel
// show it: one glyph and color per state, in GitHub's state colors (open
// green, merged purple, closed red, drafts muted), so a pull looks the same
// in either place.
export type PullDisplayState = 'closed' | 'draft' | 'merged' | 'open';

export const PULL_STATE_DISPLAY: Record<
  PullDisplayState,
  { Icon: typeof IconBranch; className: string; label: string }
> = {
  open: { Icon: IconBranch, className: 'text-[#18a46c]', label: 'Open' },
  draft: {
    Icon: IconDraft,
    className: 'text-muted-foreground',
    label: 'Draft',
  },
  merged: {
    Icon: IconMerged,
    className: 'text-violet-600 dark:text-violet-400',
    label: 'Merged',
  },
  closed: {
    Icon: IconX,
    className: 'text-red-600 dark:text-red-400',
    label: 'Closed',
  },
};
