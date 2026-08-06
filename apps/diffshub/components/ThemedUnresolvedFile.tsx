'use client';

import { type FileContents, UnresolvedFile } from '@pierre/diffs';
import { useWorkerPool } from '@pierre/diffs/react';
import { useEffect, useRef } from 'react';

import { useDiffThemeProps } from './useDiffThemeProps';
import { useWorkerDiffTheme } from './useWorkerDiffTheme';

interface ThemedUnresolvedFileProps {
  className?: string;
  // The original marked contents. Read once at mount — the instance is
  // uncontrolled and re-renders itself as regions resolve; remount via `key`
  // to reset.
  file: FileContents;
  // Fires after each resolved region with the full updated file (remaining
  // conflict markers included).
  onMergeConflictResolve(file: FileContents): void;
}

// Themed wrapper around the vanilla UnresolvedFile instance. The React
// <UnresolvedFile> component manages resolution state internally and never
// exposes the resolved contents (its options type has no
// onMergeConflictResolve), so the resolver drives the documented vanilla
// uncontrolled mode instead: the instance applies each action itself and
// reports the updated file through the callback.
export function ThemedUnresolvedFile({
  className,
  file,
  onMergeConflictResolve,
}: ThemedUnresolvedFileProps) {
  const diffTheme = useDiffThemeProps();
  useWorkerDiffTheme(diffTheme.theme, false);
  const poolManager = useWorkerPool();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<UnresolvedFile<undefined> | null>(null);
  // Latest-value refs so the mount effect never re-runs for callback or
  // theme-identity churn (a re-created instance would drop resolution state).
  const resolveRef = useRef(onMergeConflictResolve);
  resolveRef.current = onMergeConflictResolve;
  const themeRef = useRef(diffTheme);
  themeRef.current = diffTheme;

  useEffect(() => {
    const container = containerRef.current;
    if (container == null) {
      return;
    }
    const instance = new UnresolvedFile<undefined>(
      {
        mergeConflictActionsType: 'default',
        onMergeConflictResolve: (updated) => resolveRef.current(updated),
        theme: themeRef.current.theme,
        themeType: themeRef.current.themeType,
      },
      poolManager
    );
    instanceRef.current = instance;
    instance.render({ containerWrapper: container, file });
    return () => {
      instance.cleanUp();
      instanceRef.current = null;
      container.replaceChildren();
    };
  }, [file, poolManager]);

  // Follow theme switches without remounting (mount applies the same values,
  // and the reference check makes that first pass a no-op).
  useEffect(() => {
    const instance = instanceRef.current;
    if (
      instance == null ||
      (instance.options.theme === diffTheme.theme &&
        instance.options.themeType === diffTheme.themeType)
    ) {
      return;
    }
    instance.setOptions({
      ...instance.options,
      theme: diffTheme.theme,
      themeType: diffTheme.themeType,
    });
    instance.rerender();
  }, [diffTheme]);

  return <div ref={containerRef} className={className} />;
}
