'use client';

import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/cn';
import { readStoredJSON, writeStoredJSON } from '@/lib/storedJSON';

// The grid's first column reads this variable, falling back to the default
// width; ReviewGrid's `md:grid-cols-[var(--diffshub-sidebar-width,320px)_…]`
// class repeats both literally, since Tailwind classes can't interpolate.
const SIDEBAR_WIDTH_VAR = '--diffshub-sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 320;

const STORAGE_KEY = 'diffshub.sidebar-width';
const MIN_WIDTH = 240;
const MAX_WIDTH = 720;
// Leaves the viewer at least this much room when the window is narrow.
const MIN_VIEWER_WIDTH = 480;
const KEYBOARD_STEP = 16;

// Clamps a requested width to the allowed range for the current window.
function clampWidth(width: number): number {
  return Math.round(
    Math.max(
      MIN_WIDTH,
      Math.min(width, MAX_WIDTH, window.innerWidth - MIN_VIEWER_WIDTH)
    )
  );
}

// Sizes the grid's sidebar column and mirrors the width onto the separator's
// aria-valuenow.
function applySidebarWidth(
  grid: HTMLElement | null,
  handle: HTMLElement | null,
  width: number
): void {
  grid?.style.setProperty(SIDEBAR_WIDTH_VAR, `${width}px`);
  handle?.setAttribute('aria-valuenow', String(width));
}

// A drag handle on the sidebar's right edge that resizes the grid's sidebar
// column by writing SIDEBAR_WIDTH_VAR onto `gridRef` (straight to the DOM, so
// dragging never re-renders the sidebar or viewer). It sits in the grid's
// `tree` area, straddling the sidebar's border.
//
// The viewer's chosen width persists per browser; the applied width is that
// choice clamped to the current window, so narrowing the window shrinks the
// sidebar and widening it again restores the choice. Double-click or Home
// restores the default; arrow keys resize it when focused, as the separator
// role expects. Hidden below the md breakpoint, where the sidebar is an
// overlay.
export function SidebarResizeHandle({
  gridRef,
}: {
  gridRef: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The viewer's chosen width. A ref, not state: applying it changes the grid
  // and the separator's aria-valuenow directly, so nothing here re-renders.
  const preferredRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const [dragging, setDragging] = useState(false);
  // The pointer's starting x and the width at drag start, plus the latest
  // width applied during the drag (committed when it ends).
  const dragRef = useRef<{
    startWidth: number;
    startX: number;
    width: number;
  } | null>(null);

  const applyWidth = (width: number) =>
    applySidebarWidth(gridRef.current, ref.current, width);

  // Restore the stored width before paint so the column doesn't jump, then
  // re-clamp it whenever the window resizes so the viewer keeps its minimum
  // width.
  useLayoutEffect(() => {
    const fitToWindow = () =>
      applySidebarWidth(
        gridRef.current,
        ref.current,
        clampWidth(preferredRef.current)
      );
    const stored = readStoredJSON(STORAGE_KEY);
    if (typeof stored === 'number' && stored > 0) {
      preferredRef.current = stored;
    }
    fitToWindow();
    window.addEventListener('resize', fitToWindow);
    return () => window.removeEventListener('resize', fitToWindow);
  }, [gridRef]);

  const commit = (width: number) => {
    preferredRef.current = width;
    applyWidth(width);
    writeStoredJSON(
      STORAGE_KEY,
      width === DEFAULT_SIDEBAR_WIDTH ? null : width
    );
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = clampWidth(preferredRef.current);
    dragRef.current = { startWidth: width, startX: event.clientX, width };
    setDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag == null) {
      return;
    }
    drag.width = clampWidth(drag.startWidth + event.clientX - drag.startX);
    applyWidth(drag.width);
  };

  // Runs on lostpointercapture, which follows pointerup and pointercancel.
  const handlePointerEnd = () => {
    const drag = dragRef.current;
    if (drag == null) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    commit(drag.width);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP * 4 : KEYBOARD_STEP;
    const width = clampWidth(preferredRef.current);
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      commit(clampWidth(width - step));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      commit(clampWidth(width + step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      commit(DEFAULT_SIDEBAR_WIDTH);
    }
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      // Kept current by applyWidth; React leaves it alone since this initial
      // value never changes between renders.
      aria-valuenow={DEFAULT_SIDEBAR_WIDTH}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className={cn(
        // Straddles the sidebar's right border; the visible line is the
        // ::after pseudo-element so the hit area can stay wider than it.
        'relative z-40 hidden w-2 translate-x-1/2 cursor-col-resize touch-none self-stretch justify-self-end outline-none select-none [grid-area:tree] md:block',
        "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-transparent after:transition-colors after:content-['']",
        'hover:after:bg-[var(--color-border-opaque)] focus-visible:after:bg-blue-500',
        dragging && 'after:bg-blue-500 hover:after:bg-blue-500'
      )}
      onDoubleClick={() => commit(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
    />
  );
}
