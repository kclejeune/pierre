// Shared styling for ghost icon buttons that sit directly on the themed Shiki
// chrome (the header action row and the sidebar's tools). They suppress the
// default ghost hover background and the focus-visible ring/border so the
// buttons stay flush with the chrome surface, signalling both hover and
// keyboard focus with a foreground-color shift instead of a filled background.
export const CHROME_ICON_BUTTON_CLASS =
  'hover:bg-transparent hover:text-muted-foreground focus-visible:border-transparent focus-visible:text-muted-foreground focus-visible:ring-0';

// An outlined group of chrome triggers that belong together (the diff
// header's pull request + commit range). Put CHROME_SEGMENT_DIVIDER_CLASS
// spans between items; items take CHROME_SEGMENT_ITEM_CLASS on top of
// CHROME_ICON_BUTTON_CLASS, which fills them to the group's height, squares
// their corners (the group's border rounds the ends), and brings back a
// hover fill so each item reads as its own button.
export const CHROME_SEGMENT_CLASS =
  'flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--color-border-opaque)]';
export const CHROME_SEGMENT_DIVIDER_CLASS =
  'w-px shrink-0 bg-[var(--color-border-opaque)]';
export const CHROME_SEGMENT_ITEM_CLASS =
  'h-full rounded-none hover:bg-muted/70 hover:text-foreground';
