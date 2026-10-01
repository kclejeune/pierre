// macOS detection for choosing shortcut modifiers and their labels (⌘ vs
// Ctrl). Only call it from client-side code paths: it reads `navigator`.
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
}

// The keys that walk back through in-viewer jumps (go to definition).
export function getNavigateBackShortcutLabel(): string {
  return isMacPlatform() ? '⌥← or ⌃-' : 'Alt+←';
}
