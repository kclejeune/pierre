// URL handling for images referenced by a rendered markdown document. The
// document lives at a path inside the repository, so relative references
// resolve against its directory (GitHub's rendering semantics); the resolved
// repo path is then served through the /api/github-doc-asset proxy, which
// fetches it from the raw file host at the diff's resolved ref.

// Resolves an image reference to a repository path, or null when the
// reference already points somewhere loadable as-is (absolute URLs) or is not
// a file reference at all (anchors, empty).
export function resolveDocAssetPath(
  src: string,
  docPath: string
): string | null {
  if (src === '' || src.startsWith('#') || src.startsWith('//')) {
    return null;
  }
  // Any scheme-qualified URL (https:, data:, …) loads directly.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    return null;
  }

  // file:/// gives URL resolution a rooted base, so ./ and ../ segments
  // collapse with the same semantics GitHub applies; a leading / resolves
  // from the repository root.
  let resolved: URL;
  try {
    resolved = new URL(src, `file:///${docPath}`);
  } catch {
    return null;
  }
  const path = decodeURIComponent(resolved.pathname).replace(/^\/+/, '');
  return path === '' ? null : path;
}

export function createDocAssetURL(
  sourcePath: string,
  file: string,
  side: 'old' | 'new'
): string {
  const params = new URLSearchParams({ file, path: sourcePath });
  if (side === 'old') {
    params.set('side', 'old');
  }
  return `/api/github-doc-asset?${params}`;
}
