// Splits a repository path into its directory and file name, for displays
// that lead with the file name and let the directory truncate.
export function splitPath(path: string): { dirname: string; basename: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dirname: '', basename: path }
    : { dirname: path.slice(0, slash), basename: path.slice(slash + 1) };
}
