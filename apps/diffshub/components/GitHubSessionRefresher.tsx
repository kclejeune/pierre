'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';

import {
  nextGitHubRefreshDueAt,
  refreshGitHubSessionIfNeeded,
} from './githubSession';

// Keeps an expiring GitHub App sign-in alive for as long as the tab is open.
// Mounted once at the root; renders nothing. Checks the stored session on
// mount, then sleeps until the next refresh is due, and re-checks whenever
// the tab comes back (focus, visibility, network) — the laptop-lid case,
// where the token expired while asleep and no timer fired. PATs, OAuth App
// tokens, and non-expiring GitHub App tokens carry no session, so for them
// the mount check is the only work ever done.
//
// When the refresh token itself is rejected the stored credentials are
// already gone and the require-login gate (if any) has already redirected;
// all that is left to do here is tell the viewer why they are signed out.
// How long to wait before retrying after GitHub or the server was
// unreachable: the refresh is already overdue by then, so the next due time
// would otherwise be "now" and spin.
const RETRY_DELAY_MS = 60 * 1000;

export function GitHubSessionRefresher() {
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;

    function armTimer(delayOverride?: number): void {
      window.clearTimeout(timer);
      const dueAt = nextGitHubRefreshDueAt();
      if (dueAt == null) {
        return;
      }
      // setTimeout treats delays over 2^31-1 ms as 0; clamp so a fresh
      // 8-hour token does not fire a refresh immediately.
      const delay = Math.min(
        delayOverride ?? Math.max(dueAt - Date.now(), 0),
        0x7fffffff
      );
      timer = window.setTimeout(check, delay);
    }

    function check(): void {
      void refreshGitHubSessionIfNeeded().then((outcome) => {
        if (disposed) {
          return;
        }
        if (outcome === 'signed-out') {
          toast.error(
            'Your GitHub sign-in expired. Sign in again to keep loading private diffs.'
          );
        }
        armTimer(outcome === 'failed' ? RETRY_DELAY_MS : undefined);
      });
    }

    function checkWhenVisible(): void {
      if (document.visibilityState === 'visible') {
        check();
      }
    }

    check();
    document.addEventListener('visibilitychange', checkWhenVisible);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', checkWhenVisible);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
  }, []);

  return null;
}
