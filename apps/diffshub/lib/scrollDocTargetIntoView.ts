import type { CodeViewHandle } from '@pierre/diffs/react';

import type { CommentMetadata } from './types';

// What a doc-target resolver reports on each poll: the element to center, that
// the target does not exist yet (the item or its document is still mounting or
// loading), or that it never will (the document failed to render).
export type DocScrollTarget = Element | 'pending' | 'unavailable';

const CANCEL_EVENTS = ['wheel', 'touchstart', 'keydown'] as const;
const POLL_INTERVAL_MS = 120;
const DEADLINE_MS = 8000;

// Cancels the previous loop whenever a new doc-target scroll starts.
let cancelActive: (() => void) | null = null;

// Stops any in-flight doc-target scroll, so a newer navigation that does not
// target a document is not fought by a stale loop still re-centering.
export function cancelDocTargetScroll(): void {
  cancelActive?.();
}

// Centers an element inside an item's rendered markdown document
// (MarkdownDocAnnotation) in the viewport. While the element is not mounted
// yet, the item is first brought into the virtualizer's window with an
// instant scroll: a smooth item scroll keeps animating toward the item's top
// while this loop centers the element, and the two fight visibly. The element
// appears once the item mounts AND the document hydrates — a network fetch on
// partial diffs — so the loop polls `resolve` against a generous deadline
// rather than a fixed frame count, and keeps re-centering until layout stops
// shifting (mounting neighbors re-measure underneath a one-shot
// scrollIntoView). Any manual scroll or key input cancels it so the page never
// fights the user. `onUnavailable` runs if the resolver reports the target can
// never appear, letting the caller fall back.
export function scrollDocTargetIntoView(
  viewer: Pick<CodeViewHandle<CommentMetadata, undefined>, 'scrollTo'>,
  itemId: string,
  resolve: () => DocScrollTarget,
  onUnavailable?: () => void
): void {
  cancelActive?.();
  const deadline = Date.now() + DEADLINE_MS;
  let stableChecks = 0;
  let scrolledToItem = false;
  let element: Element | null = null;
  let timer: number | undefined;
  const listeners = new AbortController();
  const cleanup = () => {
    window.clearTimeout(timer);
    listeners.abort();
    if (cancelActive === cleanup) {
      cancelActive = null;
    }
  };
  cancelActive = cleanup;
  for (const type of CANCEL_EVENTS) {
    window.addEventListener(type, cleanup, {
      capture: true,
      passive: true,
      signal: listeners.signal,
    });
  }
  const tick = () => {
    if (Date.now() > deadline) {
      cleanup();
      return;
    }
    // Keep the resolved element while it stays mounted; only re-resolve once
    // the virtualizer or a re-render replaces it.
    if (element == null || !element.isConnected) {
      const target = resolve();
      if (target === 'unavailable') {
        cleanup();
        onUnavailable?.();
        return;
      }
      element = target === 'pending' ? null : target;
    }
    if (element == null) {
      // Bring the item into the virtualizer's window only before the target
      // first appears; if it unmounts later, the viewport has moved on.
      if (!scrolledToItem) {
        scrolledToItem = true;
        viewer.scrollTo({
          type: 'item',
          id: itemId,
          align: 'start',
          behavior: 'instant',
        });
      }
    } else {
      scrolledToItem = true;
      const rect = element.getBoundingClientRect();
      const visible =
        rect.top < window.innerHeight * 0.75 &&
        rect.bottom > window.innerHeight * 0.25;
      if (visible) {
        // Stop once the target has stayed put for a few checks — layout has
        // settled and lingering longer would only risk fighting the user.
        if (++stableChecks >= 5) {
          cleanup();
          return;
        }
      } else {
        stableChecks = 0;
        element.scrollIntoView({ behavior: 'auto', block: 'center' });
      }
    }
    timer = window.setTimeout(tick, POLL_INTERVAL_MS);
  };
  tick();
}
