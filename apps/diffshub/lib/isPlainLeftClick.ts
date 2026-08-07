// Whether a click should be handled in-app; modified clicks (new tab,
// download, …) keep browser behavior and follow the href.
export function isPlainLeftClick(event: React.MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
