// Shared styling for ghost icon buttons that sit directly on the themed Shiki
// chrome (the header action row and the sidebar's tools). They suppress the
// default ghost hover background and the focus-visible ring/border so the
// buttons stay flush with the chrome surface, signalling both hover and
// keyboard focus with a foreground-color shift instead of a filled background.
//
// On touch screens (coarse pointers) each button also grows an invisible
// hit area 6px above and below, so a 32px chrome button takes a 44px-tall
// tap without changing the layout. It extends only vertically: the buttons
// sit 4px apart in a row, and widening them would let neighbors' hit areas
// overlap.
export const CHROME_ICON_BUTTON_CLASS =
  'hover:bg-transparent hover:text-muted-foreground focus-visible:border-transparent focus-visible:text-muted-foreground focus-visible:ring-0 ' +
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:content-['']";

// An outlined group of chrome triggers that belong together (the diff
// header's pull request + commit range). Put CHROME_SEGMENT_DIVIDER_CLASS
// spans between items; items take CHROME_SEGMENT_ITEM_CLASS on top of
// CHROME_ICON_BUTTON_CLASS, which fills them to the group's height, squares
// their corners (the group's border rounds the ends), and brings back a
// hover fill so each item reads as its own button.
//
// The group clips its items (overflow-hidden), which would cut off their
// touch hit areas, so on touch screens the group itself grows to 36px.
export const CHROME_SEGMENT_CLASS =
  'flex h-7 pointer-coarse:h-9 items-stretch overflow-hidden rounded-md border border-[var(--color-border-opaque)]';
export const CHROME_SEGMENT_DIVIDER_CLASS =
  'w-px shrink-0 bg-[var(--color-border-opaque)]';
export const CHROME_SEGMENT_ITEM_CLASS =
  'h-full rounded-none hover:bg-muted/70 hover:text-foreground';

// The same invisible touch hit area for the 24px icon buttons in a diff
// file's header (collapse, comment, rendered-doc toggle, Viewed). Those rows
// have estimated heights in the virtualized list, so the buttons can't grow;
// on coarse pointers the hit area reaches 32x40 instead, overlapping the
// ~6px gaps between neighbors by at most a few pixels.
export const FILE_HEADER_TOUCH_TARGET_CLASS =
  "relative pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-2 pointer-coarse:after:content-['']";

// A file header's 24px ghost icon button (collapse, comment, rendered-doc
// toggle, edit), including the touch hit area above.
export const FILE_HEADER_ICON_BUTTON_CLASS =
  'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition ' +
  FILE_HEADER_TOUCH_TARGET_CLASS;
