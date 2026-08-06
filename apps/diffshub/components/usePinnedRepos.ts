'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  loadPinnedRepos,
  PINNED_REPOS_EVENT,
  savePinnedRepos,
  togglePinnedRepo,
} from '@/lib/pinnedRepos';

// Shared view of the pinned-repo list. Loads after mount (SSR renders no
// pins), and re-loads whenever any other consumer saves — savePinnedRepos
// broadcasts a window event — so the dashboard, viewer header, and palette
// stay in sync without threading state between them.
export function usePinnedRepos(): {
  hydrated: boolean;
  pinned: string[];
  toggle: (repo: string) => void;
} {
  const [pinned, setPinned] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPinned(loadPinnedRepos());
    setHydrated(true);
    const onChange = () => setPinned(loadPinnedRepos());
    window.addEventListener(PINNED_REPOS_EVENT, onChange);
    return () => window.removeEventListener(PINNED_REPOS_EVENT, onChange);
  }, []);

  const toggle = useCallback((repo: string) => {
    savePinnedRepos(togglePinnedRepo(loadPinnedRepos(), repo));
  }, []);

  return { hydrated, pinned, toggle };
}
