'use client';

import { useCallback } from 'react';

import { useSyncedValue } from './useSyncedList';
import {
  addMutedBranch,
  loadMuteRules,
  MUTE_RULES_EVENT,
  type MuteRules,
  removeMutedBranch,
  saveMuteRules,
} from '@/lib/muteRules';

const EMPTY_RULES: MuteRules = { branches: [] };

// Shared view of the viewer's branch and staleness muting (lib/muteRules),
// kept in sync across consumers (see useSyncedValue). Each change re-reads
// the stored rules first, so two consumers never overwrite each other.
export function useMuteRules(): {
  hydrated: boolean;
  muteBranch: (prefix: string) => void;
  rules: MuteRules;
  // A duration ("60d", "off"), or undefined to follow the deployment default.
  setStaleAfter: (value: string | undefined) => void;
  unmuteBranch: (prefix: string) => void;
} {
  const { hydrated, value } = useSyncedValue(
    loadMuteRules,
    MUTE_RULES_EVENT,
    'muteRules',
    EMPTY_RULES
  );
  const muteBranch = useCallback((prefix: string) => {
    saveMuteRules(addMutedBranch(loadMuteRules(), prefix));
  }, []);
  const unmuteBranch = useCallback((prefix: string) => {
    saveMuteRules(removeMutedBranch(loadMuteRules(), prefix));
  }, []);
  // saveMuteRules normalizes the duration (and drops one it can't read).
  const setStaleAfter = useCallback((next: string | undefined) => {
    const { staleAfter: _previous, ...rest } = loadMuteRules();
    saveMuteRules(next == null ? rest : { ...rest, staleAfter: next });
  }, []);
  return { hydrated, muteBranch, rules: value, setStaleAfter, unmuteBranch };
}
