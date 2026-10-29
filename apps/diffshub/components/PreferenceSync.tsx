'use client';

import { useEffect } from 'react';

import { useGitHubToken } from './useGitHubToken';
import {
  flushPendingPreferences,
  startPreferenceSync,
} from '@/lib/preferenceSync';
import { flushPendingReviewedFiles } from '@/lib/reviewedFilesSync';

// Drives lib/preferenceSync for the signed-in viewer. Mounted once at the
// root; renders nothing. Starts the sync once the stored token is known (and
// again on sign-in, sign-out, or a refreshed token), retries a failed load
// when the tab comes back, and sends pending debounced writes when the page
// is hidden so changes made just before closing a tab are not lost.
export function PreferenceSync() {
  const { hydrated, token } = useGitHubToken();

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    startPreferenceSync(token);
    const retry = () => {
      if (document.visibilityState === 'visible') {
        startPreferenceSync(token);
      }
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [hydrated, token]);

  useEffect(() => {
    const flushAll = () => {
      flushPendingPreferences();
      flushPendingReviewedFiles();
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        flushAll();
      }
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('pagehide', flushAll);
    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pagehide', flushAll);
    };
  }, []);

  return null;
}
