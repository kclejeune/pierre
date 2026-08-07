'use client';

import { useWorkerPool } from '@pierre/diffs/react';
import { useEffect, useRef, useState } from 'react';

// True once the highlighting worker pool has initialized (or when there is no
// pool at all). Pages gate CodeView mounting on this so the first tokenize
// pass never runs against an uninitialized pool.
export function useIsWorkerPoolReadyOrDisabled() {
  const workerPool = useWorkerPool();
  const [isReady, setIsReady] = useState(
    () => workerPool?.isInitialized() ?? true
  );
  const isReadyRef = useRef(isReady);
  useEffect(() => {
    // The callback will always be fired immediately with the new state, so we
    // don't need to check for it in the effect
    return workerPool?.subscribeToStatChanges((stats) => {
      const isReady = stats.managerState === 'initialized';
      if (isReady !== isReadyRef.current) {
        setIsReady(isReady);
        isReadyRef.current = isReady;
      }
    });
  }, [workerPool]);
  return isReady;
}
