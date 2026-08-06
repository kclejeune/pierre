import { diff3Merge } from 'node-diff3';

// The pure core of merging a pull request's base branch into its head branch
// server-side. A correct merge commit's tree is the HEAD tree overridden at
// every path where the base branch diverged from the merge base:
//
//   unchanged on base  → head's version wins (covered by base_tree = head)
//   changed base-only  → base's version wins (reuse base's existing blob)
//   removed base-only  → deleted (null-sha tree entry)
//   changed both sides → three-way merged content (auto or user-resolved)
//
// Renames touching contested paths, delete/modify pairs, type changes, and
// binary conflicts are reported as unsupported and refuse the merge loudly —
// never silently committing a wrong tree.

// GitHub compare API file statuses.
export type ChangeStatus =
  | 'added'
  | 'changed'
  | 'copied'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'unchanged';

export interface CompareFile {
  filename: string;
  previousFilename?: string;
  status: ChangeStatus;
}

export type MergeFilePlan =
  // Base-only add/modify: point the merge tree at base's existing blob (no
  // content read — binary-safe, mode preserved from base's tree).
  | { kind: 'take-base'; path: string }
  // Base-only removal: null-sha tree entry.
  | { kind: 'delete'; path: string }
  // Changed on both sides: needs diff3 (clean auto-merge or user resolution).
  // addAdd marks add/add pairs, whose merge base is the empty file.
  | { kind: 'merge'; path: string; addAdd: boolean }
  | { kind: 'unsupported'; path: string; reason: string };

export interface MergeInputs {
  // compare(mergeBase → base tip).files
  baseChanges: readonly CompareFile[];
  // compare(mergeBase → head tip).files
  headChanges: readonly CompareFile[];
}

export function planMerge({
  baseChanges,
  headChanges,
}: MergeInputs): MergeFilePlan[] {
  // Every path the head side touched, including rename sources: a base
  // change at any of these paths is contested.
  const headTouched = new Map<string, ChangeStatus>();
  for (const change of headChanges) {
    headTouched.set(change.filename, change.status);
    if (change.previousFilename != null) {
      // A rename source was effectively removed on the head side.
      headTouched.set(change.previousFilename, 'removed');
    }
  }

  const plans: MergeFilePlan[] = [];
  for (const change of baseChanges) {
    const path = change.filename;
    const headStatus = headTouched.get(path);

    if (change.status === 'renamed' || change.status === 'copied') {
      const source = change.previousFilename;
      const sourceContested =
        source != null &&
        headTouched.has(source) &&
        change.status === 'renamed';
      if (headStatus != null || sourceContested) {
        plans.push({
          kind: 'unsupported',
          path,
          reason: `The base branch ${change.status} this file and the pull request also touches it — resolve with git locally.`,
        });
        continue;
      }
      // An uncontested base-side rename/copy is just an add at the new path
      // (plus a delete of the source for renames).
      plans.push({ kind: 'take-base', path });
      if (change.status === 'renamed' && source != null) {
        plans.push({ kind: 'delete', path: source });
      }
      continue;
    }

    if (change.status === 'removed') {
      if (headStatus == null) {
        plans.push({ kind: 'delete', path });
      } else if (headStatus === 'removed') {
        // Deleted on both sides — the head tree already lacks it.
      } else {
        plans.push({
          kind: 'unsupported',
          path,
          reason:
            'The base branch deleted this file but the pull request modified it — resolve with git locally.',
        });
      }
      continue;
    }

    if (change.status === 'added' || change.status === 'modified') {
      if (headStatus == null) {
        plans.push({ kind: 'take-base', path });
      } else if (headStatus === 'removed') {
        plans.push({
          kind: 'unsupported',
          path,
          reason:
            'The pull request deleted this file but the base branch modified it — resolve with git locally.',
        });
      } else if (headStatus === 'renamed' || headStatus === 'copied') {
        plans.push({
          kind: 'unsupported',
          path,
          reason: `The pull request ${headStatus} this file while the base branch changed it — resolve with git locally.`,
        });
      } else {
        plans.push({
          kind: 'merge',
          path,
          addAdd: change.status === 'added',
        });
      }
      continue;
    }

    if (change.status === 'changed') {
      // File-type changes (e.g. file ↔ symlink) are too subtle to merge here.
      if (headStatus == null) {
        plans.push({ kind: 'take-base', path });
      } else {
        plans.push({
          kind: 'unsupported',
          path,
          reason:
            'The file type changed on the base branch — resolve with git locally.',
        });
      }
      continue;
    }
    // 'unchanged' entries need nothing.
  }
  return plans;
}

export interface ConflictMarkerLabels {
  base: string;
  ours: string;
  theirs: string;
}

export interface RenderConflictMarkersResult {
  conflictCount: number;
  text: string;
}

// Runs diff3 and emits git-style conflict markers (with a ||||||| base
// section, which UnresolvedFile parses and offers to strip). ours = the pull
// request head ("current"), theirs = the base branch ("incoming").
export function renderConflictMarkers(
  base: string,
  ours: string,
  theirs: string,
  labels: ConflictMarkerLabels
): RenderConflictMarkersResult {
  const regions = diff3Merge(
    splitLines(ours),
    splitLines(base),
    splitLines(theirs)
  );
  const lines: string[] = [];
  let conflictCount = 0;
  for (const region of regions) {
    if (region.ok != null) {
      lines.push(...region.ok);
      continue;
    }
    if (region.conflict == null) {
      continue;
    }
    conflictCount += 1;
    lines.push(`<<<<<<< ${labels.ours}`);
    lines.push(...region.conflict.a);
    lines.push(`||||||| ${labels.base}`);
    lines.push(...region.conflict.o);
    lines.push('=======');
    lines.push(...region.conflict.b);
    lines.push(`>>>>>>> ${labels.theirs}`);
  }
  return { conflictCount, text: lines.join('\n') };
}

// Split into lines such that join('\n') reproduces the input exactly — a
// trailing newline yields a final empty element that survives the round trip.
function splitLines(text: string): string[] {
  return text.split('\n');
}

const CONFLICT_START_PATTERN = /^<{7}( |$)/;

export function countRemainingConflicts(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (CONFLICT_START_PATTERN.test(line)) {
      count += 1;
    }
  }
  return count;
}

// NUL bytes mark content this text-only merge pipeline must refuse.
export function isBinaryContent(text: string): boolean {
  return text.includes('\0');
}
