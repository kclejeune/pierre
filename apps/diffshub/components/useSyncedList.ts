'use client';

import { useEffect, useState } from 'react';

import {
  onPreferencesRestored,
  type SyncedPreference,
} from '@/lib/preferenceSync';

// A synced preference list (pins, muted authors) as React state. Loads after
// mount (SSR renders an empty list), and re-loads whenever any consumer saves
// (the store's save broadcasts `event` on window) or the server restores the
// preference after sign-in (lib/preferenceSync), so every mounted consumer
// stays in sync without threading state between them.
export function useSyncedList(
  load: () => string[],
  event: string,
  preference: SyncedPreference
): { hydrated: boolean; list: string[] } {
  const [list, setList] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setList(load());
    setHydrated(true);
    const onChange = () => setList(load());
    window.addEventListener(event, onChange);
    const stopRestoreListener = onPreferencesRestored([preference], onChange);
    return () => {
      window.removeEventListener(event, onChange);
      stopRestoreListener();
    };
  }, [event, load, preference]);

  return { hydrated, list };
}
