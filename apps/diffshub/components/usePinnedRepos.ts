'use client';

import { useCallback } from 'react';

import { useSyncedList } from './useSyncedList';
import {
  loadPinnedRepos,
  PINNED_REPOS_EVENT,
  savePinnedRepos,
  togglePinnedRepo,
} from '@/lib/pinnedRepos';

// Shared view of the pinned-repo list, kept in sync across the dashboard,
// viewer header, and palette (see useSyncedList).
export function usePinnedRepos(): {
  hydrated: boolean;
  pinned: string[];
  toggle: (repo: string) => void;
} {
  const { hydrated, list } = useSyncedList(
    loadPinnedRepos,
    PINNED_REPOS_EVENT,
    'pinnedRepos'
  );
  const toggle = useCallback((repo: string) => {
    savePinnedRepos(togglePinnedRepo(loadPinnedRepos(), repo));
  }, []);
  return { hydrated, pinned: list, toggle };
}
