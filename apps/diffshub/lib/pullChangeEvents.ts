// A page-wide signal that a pull's reviews or merge state changed through
// this app (a review submitted from the diff view, the quick look, or the
// /pulls batch bar; a merge), so views already showing that pull, like the
// details panel's reviewer verdicts and merge controls, reload what they
// hold instead of waiting for the head commit to move. Listeners hear the
// pull's "owner/repo#number" key. The pull's prefetched responses (tagged
// with the same key) are dropped first, so those reloads, and any later
// read, go to the network.

import { pullKey } from './githubPullSummaries';
import { discardTagged } from './prefetchStore';
import type { PullRequestRef } from './pullCommentsClient';

const listeners = new Set<(key: string) => void>();

export function pullChangeKey(pull: PullRequestRef): string {
  return pullKey(pull).toLowerCase();
}

// Tells every listener that `pull` changed.
export function notifyPullChanged(pull: PullRequestRef): void {
  const key = pullChangeKey(pull);
  discardTagged(key);
  for (const listener of listeners) {
    listener(key);
  }
}

// Calls `listener` with a pull's key whenever one changes. Returns the
// unsubscribe.
export function subscribePullChanges(
  listener: (key: string) => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
