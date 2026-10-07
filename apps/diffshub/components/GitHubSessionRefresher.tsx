'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';

import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import {
  discardUnsealedGitHubCredentials,
  type GitHubSessionRefreshOutcome,
  nextGitHubRefreshDueAt,
  recoverFromRejectedGitHubToken,
  refreshGitHubSessionIfNeeded,
} from './githubSession';
import { GITHUB_TOKEN_REJECTED_EVENT } from '@/lib/rejectedCredential';

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
//
// It also handles tokens the server rejects before their stored expiry (see
// lib/rejectedCredential): any API 401 to a tokened request triggers a forced
// refresh, or a sign-out when no refresh is possible.
// How long to wait before retrying after GitHub or the server was
// unreachable: the refresh is already overdue by then, so the next due time
// would otherwise be "now" and spin.
const RETRY_DELAY_MS = 60 * 1000;

const SIGNED_OUT_TOAST_ID = 'github-signed-out';

export function GitHubSessionRefresher() {
  const { tokenEncryptionRequired } = useGitHubEnvironment();
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

    function handleOutcome(outcome: GitHubSessionRefreshOutcome): void {
      if (disposed) {
        return;
      }
      if (outcome === 'signed-out') {
        toast.error(
          'Your GitHub sign-in expired. Sign in again to keep loading private diffs.',
          { id: SIGNED_OUT_TOAST_ID }
        );
      }
      armTimer(outcome === 'failed' ? RETRY_DELAY_MS : undefined);
    }

    function check(): void {
      if (discardUnsealedGitHubCredentials(tokenEncryptionRequired)) {
        return;
      }
      void refreshGitHubSessionIfNeeded().then(handleOutcome);
    }

    // Several requests usually fail together with the same dead token; the
    // recovery is single-flight and ignores tokens already replaced, and the
    // toast id collapses any repeats.
    function recoverFromRejection(event: Event): void {
      const rejectedToken = (event as CustomEvent<string>).detail;
      void recoverFromRejectedGitHubToken(rejectedToken).then(handleOutcome);
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
    window.addEventListener(GITHUB_TOKEN_REJECTED_EVENT, recoverFromRejection);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', checkWhenVisible);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      window.removeEventListener(
        GITHUB_TOKEN_REJECTED_EVENT,
        recoverFromRejection
      );
    };
  }, [tokenEncryptionRequired]);

  return null;
}
