'use client';

import type { Editor, EditorOptions, EditorType } from '@pierre/diffs/edit';
import { EditProvider } from '@pierre/diffs/react';
import { type ReactNode, useEffect } from 'react';

// Provides the editor factory the diffs edit surfaces require (they throw
// "EditContext is not attached" without one). The experimental editor entry
// point is dynamically imported on mount so it stays out of the initial
// bundle; createEditor must stay synchronous per the EditProvider contract,
// so it reads the module from this holder. The import resolves in
// milliseconds — long before any edit toggle can be clicked.
let editModule: typeof import('@pierre/diffs/edit') | null = null;

function createEditor<EType extends EditorType, LAnnotation, Caret>(
  editorType: EType,
  options: EditorOptions<EType, LAnnotation, Caret>,
  editStateKey?: string
): Editor<EType, LAnnotation, Caret> {
  if (editModule == null) {
    throw new Error('The editor is still loading — try again in a moment.');
  }
  return new editModule.Editor(editorType, options, editStateKey);
}

export function AppEditProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void import('@pierre/diffs/edit').then((module) => {
      editModule = module;
    });
  }, []);
  return <EditProvider createEditor={createEditor}>{children}</EditProvider>;
}
