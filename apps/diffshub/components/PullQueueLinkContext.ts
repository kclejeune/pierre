'use client';

import { createContext, use, useMemo } from 'react';

import { withPullQueue } from '@/lib/pullQueue';

// The id of the /pulls list on screen (lib/pullQueue's pullQueueId), which
// the dashboard's diff links carry as ?queue= so the diff view can step
// through that list. Null outside the dashboard, where links stay plain.
export const PullQueueIdContext = createContext<string | null>(null);

// `path` as a diff link from the current /pulls list: with ?queue= naming
// the list on the dashboard, unchanged anywhere else.
export function useQueuedPullPath(path: string): string {
  const queueId = use(PullQueueIdContext);
  // Rows call this on every render; the URL parse is only redone when the
  // path or the list changes.
  return useMemo(() => withPullQueue(path, queueId), [path, queueId]);
}
