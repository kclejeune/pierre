'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Button } from './Button';
import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { isEditableEventTarget } from '@/lib/platform';
import {
  findQueuePosition,
  loadPullQueue,
  type PullQueueItem,
} from '@/lib/pullQueue';
import { recordRecentDiff } from '@/lib/recentDiffs';

// The diff header's "3 / 12" stepper through the /pulls list the viewer came
// from (lib/pullQueue): previous and next pull, also on [ and ]. Renders
// nothing unless the open pull is in that list, so diffs reached any other
// way keep their header as it was.
export function PullQueueStepper() {
  const pathname = usePathname();
  const router = useRouter();
  // Read after mount: the queue lives in localStorage.
  const [items, setItems] = useState<PullQueueItem[]>([]);
  // Commit and compare views opened from a pull name it in ?fromPull=; read
  // with the queue after mount rather than through useSearchParams, which
  // would need a Suspense boundary around the whole header.
  const [fromPull, setFromPull] = useState<string | null>(null);
  useEffect(() => {
    setItems(loadPullQueue());
    setFromPull(new URLSearchParams(window.location.search).get('fromPull'));
  }, [pathname]);
  const position = findQueuePosition(items, pathname, fromPull);
  const previous = position > 0 ? items[position - 1] : undefined;
  const next =
    position !== -1 && position < items.length - 1
      ? items[position + 1]
      : undefined;

  // Steps to a neighbor in the same tab, recording it in recents like any
  // opened diff (queue items share recents' {path, title} shape).
  const go = useCallback(
    (target: PullQueueItem) => {
      recordRecentDiff(target);
      router.push(target.path);
    },
    [router]
  );

  useEffect(() => {
    if (position === -1) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableEventTarget(event) ||
        document.querySelector('[role="dialog"], [role="menu"]') != null
      ) {
        return;
      }
      const target =
        event.key === ']' ? next : event.key === '[' ? previous : undefined;
      if (target != null) {
        event.preventDefault();
        go(target);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [go, next, position, previous]);

  if (position === -1) {
    return null;
  }
  return (
    <div
      role="group"
      aria-label="Pull request queue"
      className="text-muted-foreground flex shrink-0 items-center text-xs tabular-nums"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        disabled={previous == null}
        title={
          previous == null
            ? 'Start of the list'
            : `Previous: ${previous.title} ([)`
        }
        aria-label="Previous pull request"
        className={CHROME_ICON_BUTTON_CLASS}
        onClick={() => previous != null && go(previous)}
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <span title="Position in the /pulls list this diff was opened from">
        {position + 1} / {items.length}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        disabled={next == null}
        title={next == null ? 'End of the list' : `Next: ${next.title} (])`}
        aria-label="Next pull request"
        className={CHROME_ICON_BUTTON_CLASS}
        onClick={() => next != null && go(next)}
      >
        <ChevronRight className="size-3.5" />
      </Button>
    </div>
  );
}
