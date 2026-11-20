// Helpers for the app's one-shot query parameters: links that carry a
// parameter into the page (?queue=, ?comments=), which the page reads once
// and then drops from the address bar.

// Resolves app-relative paths without depending on the page's own origin.
const PROBE_ORIGIN = 'https://diffshub.invalid';

// `path` (app-relative, possibly with its own query and hash) with `name`
// set to `value`.
export function withSearchParam(
  path: string,
  name: string,
  value: string
): string {
  const url = new URL(path, PROBE_ORIGIN);
  url.searchParams.set(name, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

// Reads `name` from the current URL and removes it in place (no navigation;
// the history entry's state is kept), so a reload, a bookmark, or a copied
// address doesn't repeat it. Null when the URL doesn't carry it.
export function consumeSearchParam(name: string): string | null {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (value == null) {
    return null;
  }
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, '', url);
  return value;
}
