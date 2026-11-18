import type { UIEvent } from 'react';

// How long the thumb stays visible after the last scroll event.
const VISIBLE_AFTER_SCROLL_MS = 700;

const hideTimers = new WeakMap<HTMLElement, number>();

// onScroll handler for `.cv-autohide-scrollbar` containers: marks the element
// `data-scrolling` while scroll events keep arriving, which is what reveals
// its thumb (see globals.css), and clears the mark once scrolling stops. Kept
// as a DOM attribute rather than React state so scrolling never re-renders.
export function revealScrollbarWhileScrolling(
  event: UIEvent<HTMLElement>
): void {
  const element = event.currentTarget;
  element.dataset.scrolling = '';
  window.clearTimeout(hideTimers.get(element));
  hideTimers.set(
    element,
    window.setTimeout(() => {
      delete element.dataset.scrolling;
      hideTimers.delete(element);
    }, VISIBLE_AFTER_SCROLL_MS)
  );
}
