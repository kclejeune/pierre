// macOS detection for choosing shortcut modifiers and their labels (⌘ vs
// Ctrl). Only call it from client-side code paths: it reads `navigator`.
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
}

// The keys that walk back through in-viewer jumps (go to definition).
export function getNavigateBackShortcutLabel(): string {
  return isMacPlatform() ? '⌥← or ⌃-' : 'Alt+←';
}

// Whether a key event came from somewhere typing happens (inputs, textareas,
// selects, contenteditable, including their descendants and shadow DOM), so
// single-key page shortcuts like "/" leave it alone.
export function isEditableEventTarget(event: KeyboardEvent): boolean {
  const [target] = event.composedPath();
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable]') != null
  );
}
