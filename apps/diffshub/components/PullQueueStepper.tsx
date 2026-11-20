'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Button } from './Button';
import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { isPageShortcutEvent } from '@/lib/platform';
import {
  claimTabPullQueue,
  findQueuePosition,
  PULL_QUEUE_PARAM,
  type PullQueue,
  type PullQueueItem,
} from '@/lib/pullQueue';
import { recordRecentDiff } from '@/lib/recentDiffs';

// The diff header's "3 / 12" stepper through the /pulls list the viewer came
// from (lib/pullQueue): previous and next pull, also on [ and ], and the
// count links back to that list with its filters. Renders nothing unless the
// tab's queue (claimTabPullQueueId, which also takes a ?queue= the tab
// arrived with out of the URL) holds the open pull, so diffs outside it
// keep their header as it was.
export function PullQueueStepper() {
  const pathname = usePathname();
  const router = useRouter();
  // The header wraps this in a Suspense boundary for useSearchParams.
  const searchParams = useSearchParams();
  // Commit and compare views opened from a pull name it in ?fromPull=.
  const fromPull = searchParams.get('fromPull');
  // Re-claimed whenever ?queue= changes, so one arriving on a same-tab
  // navigation is taken up too (claiming drops it, which re-runs this once
  // more to read the tab's queue back).
  const arrivingQueue = searchParams.get(PULL_QUEUE_PARAM);
  // Read after mount: the queue lives in browser storage.
  const [queue, setQueue] = useState<PullQueue | null>(null);
  useEffect(() => {
    setQueue(claimTabPullQueue());
  }, [arrivingQueue]);
  const items = queue?.items ?? [];
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
      if (!isPageShortcutEvent(event)) {
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

  if (position === -1 || queue == null) {
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
      <Link
        className="hover:text-foreground rounded px-0.5 hover:underline"
        href={queue.listPath}
        title="Back to the /pulls list this diff was opened from"
      >
        {position + 1} / {items.length}
      </Link>
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
