import { type TreeEntry, type TreeLister } from './githubCommitServer';
import type { CompareFile } from './pullMerge';

// Lists which files differ between two git trees using the non-recursive
// trees API. The pull-conflicts route uses this when a compare listing (of
// either side) hits GitHub's 300-file cap: recursive tree listings truncate on large monorepos, so
// the walk descends one directory per request and skips any subtree whose SHA
// is identical on both sides. The request count scales with the number of
// changed directories rather than the size of the repository.
//
// Returns compare-API-shaped changes from `leftTreeSha` to `rightTreeSha`.
// Renames are reported as a removal plus an addition (git trees carry no
// rename information), and a file whose type changes (regular file, symlink,
// or submodule) is reported as `changed`, matching the compare API. When
// `paths` is given, only those files are compared and directories that cannot
// contain one of them are never listed.
export async function diffTrees(
  list: TreeLister,
  leftTreeSha: string,
  rightTreeSha: string,
  paths?: Iterable<string>
): Promise<CompareFile[]> {
  const wantedFiles = paths == null ? null : new Set(paths);
  const wantedDirectories =
    wantedFiles == null ? null : directoryPrefixes(wantedFiles);
  const changes: CompareFile[] = [];

  // Each directory recurses as soon as its own listings arrive rather than
  // waiting for the rest of its level; the caller's fetcher bounds how many
  // listings run at once.
  const walk = async (
    path: string,
    left: string | null,
    right: string | null
  ): Promise<void> => {
    if (left === right) {
      return;
    }
    const noEntries = new Map<string, TreeEntry>();
    const [leftEntries, rightEntries] = await Promise.all([
      left == null ? noEntries : list(left),
      right == null ? noEntries : list(right),
    ]);
    const subdirectories: Promise<void>[] = [];
    for (const name of new Set([
      ...leftEntries.keys(),
      ...rightEntries.keys(),
    ])) {
      const entryPath = path === '' ? name : `${path}/${name}`;
      const leftEntry = leftEntries.get(name);
      const rightEntry = rightEntries.get(name);
      if (
        leftEntry?.sha === rightEntry?.sha &&
        leftEntry?.mode === rightEntry?.mode
      ) {
        continue;
      }
      const leftTree = leftEntry?.type === 'tree' ? leftEntry.sha : null;
      const rightTree = rightEntry?.type === 'tree' ? rightEntry.sha : null;
      if (
        (leftTree != null || rightTree != null) &&
        (wantedDirectories == null || wantedDirectories.has(entryPath))
      ) {
        subdirectories.push(walk(entryPath, leftTree, rightTree));
      }
      // A file on either side that is not a directory on that side.
      const leftFile = leftTree == null ? leftEntry : undefined;
      const rightFile = rightTree == null ? rightEntry : undefined;
      if (
        (leftFile != null || rightFile != null) &&
        (wantedFiles == null || wantedFiles.has(entryPath))
      ) {
        changes.push({
          filename: entryPath,
          status: fileChangeStatus(leftFile, rightFile),
          ...(rightFile == null ? {} : { sha: rightFile.sha }),
        });
      }
    }
    await Promise.all(subdirectories);
  };

  await walk('', leftTreeSha, rightTreeSha);
  return changes.sort((left, right) =>
    left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0
  );
}

function fileChangeStatus(
  left: TreeEntry | undefined,
  right: TreeEntry | undefined
): CompareFile['status'] {
  if (left == null) {
    return 'added';
  }
  if (right == null) {
    return 'removed';
  }
  return fileKind(left) === fileKind(right) ? 'modified' : 'changed';
}

// Regular files (100644 and 100755 differ only in the executable bit) count
// as one kind; symlinks and submodules are their own kinds.
function fileKind(entry: TreeEntry): string {
  return entry.mode.startsWith('100') ? 'file' : entry.mode;
}

// Every ancestor directory of the given file paths, e.g. `a/b/c.ts` yields
// `a` and `a/b`.
function directoryPrefixes(paths: Iterable<string>): Set<string> {
  const prefixes = new Set<string>();
  for (const path of paths) {
    for (
      let slash = path.indexOf('/');
      slash >= 0;
      slash = path.indexOf('/', slash + 1)
    ) {
      prefixes.add(path.slice(0, slash));
    }
  }
  return prefixes;
}
