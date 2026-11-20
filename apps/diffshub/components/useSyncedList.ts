'use client';

import { useEffect, useState } from 'react';

import {
  onPreferencesRestored,
  type SyncedPreference,
} from '@/lib/preferenceSync';

// A synced preference (pins, muted authors, mute rules) as React state.
// Loads after mount (SSR renders `initial`), and re-loads whenever any
// consumer saves (the store's save broadcasts `event` on window) or the
// server restores the preference after sign-in (lib/preferenceSync), so
// every mounted consumer stays in sync without threading state between them.
export function useSyncedValue<T>(
  load: () => T,
  event: string,
  preference: SyncedPreference,
  initial: T
): { hydrated: boolean; value: T } {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setValue(load());
    setHydrated(true);
    const onChange = () => setValue(load());
    window.addEventListener(event, onChange);
    const stopRestoreListener = onPreferencesRestored([preference], onChange);
    return () => {
      window.removeEventListener(event, onChange);
      stopRestoreListener();
    };
  }, [event, load, preference]);

  return { hydrated, value };
}

const EMPTY_LIST: string[] = [];

// useSyncedValue for the list-shaped preferences.
export function useSyncedList(
  load: () => string[],
  event: string,
  preference: SyncedPreference
): { hydrated: boolean; list: string[] } {
  const { hydrated, value } = useSyncedValue(
    load,
    event,
    preference,
    EMPTY_LIST
  );
  return { hydrated, list: value };
}
