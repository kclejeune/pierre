'use client';

import { useCallback } from 'react';

import { useSyncedList } from './useSyncedList';
import {
  addMutedAuthors,
  loadMutedAuthors,
  MUTED_AUTHORS_EVENT,
  removeMutedAuthor,
  saveMutedAuthors,
} from '@/lib/mutedAuthors';

// Shared view of the muted-author list (lib/mutedAuthors), kept in sync
// across consumers (see useSyncedList).
export function useMutedAuthors(): {
  hydrated: boolean;
  mute: (authors: readonly string[]) => void;
  muted: string[];
  unmute: (author: string) => void;
} {
  const { hydrated, list } = useSyncedList(
    loadMutedAuthors,
    MUTED_AUTHORS_EVENT,
    'mutedAuthors'
  );
  const mute = useCallback((authors: readonly string[]) => {
    saveMutedAuthors(addMutedAuthors(loadMutedAuthors(), authors));
  }, []);
  const unmute = useCallback((author: string) => {
    saveMutedAuthors(removeMutedAuthor(loadMutedAuthors(), author));
  }, []);
  return { hydrated, mute, muted: list, unmute };
}
