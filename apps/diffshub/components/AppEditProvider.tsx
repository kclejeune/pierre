'use client';

import type { DiffsEditor } from '@pierre/diffs';
import type { EditorOptions } from '@pierre/diffs/edit';
import { EditProvider } from '@pierre/diffs/react';
import { type ReactNode, useEffect } from 'react';

// Provides the editor factory the diffs edit surfaces require (they throw
// "EditContext is not attached" without one). The experimental editor entry
// point is dynamically imported on mount so it stays out of the initial
// bundle; createEditor must stay synchronous per the EditProvider contract,
// so it reads the module from this holder. The import resolves in
// milliseconds — long before any edit toggle can be clicked.
let editModule: typeof import('@pierre/diffs/edit') | null = null;

function createEditor<LAnnotation>(
  options: EditorOptions<LAnnotation>
): DiffsEditor<LAnnotation> {
  if (editModule == null) {
    throw new Error('The editor is still loading — try again in a moment.');
  }
  return new editModule.Editor(options);
}

export function AppEditProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void import('@pierre/diffs/edit').then((module) => {
      editModule = module;
    });
  }, []);
  return <EditProvider createEditor={createEditor}>{children}</EditProvider>;
}
