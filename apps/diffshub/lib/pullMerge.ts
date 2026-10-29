import { diff3Merge } from './diff3';

// The pure core of merging a pull request's base branch into its head branch
// server-side. The merge commit's tree can be built from either tip:
//
//   onto 'head': the HEAD tree overridden at every path the base branch
//                changed (needs base's complete change list)
//   onto 'base': the BASE tree overridden at every path the pull changed
//                (needs base's status only at the pull's paths)
//
// Either way, per path of the incoming side (the one whose changes become
// tree entries):
//
//   untouched by the existing side → the incoming version wins (reuse its
//                                    blob, or delete when it was removed)
//   changed on both sides          → three-way merged content
//   untouched by the incoming side → the existing tree already has it
//
// Both directions yield the same tree. The route picks the one with fewer
// incoming changes, since every incoming change costs a tree lookup and a
// tree entry when committing.
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
  // The file's blob SHA after the change (absent for removals), which lets
  // its contents be read and cached by SHA.
  sha?: string;
  status: ChangeStatus;
}

export type MergeFilePlan =
  // An incoming-only add/modify: point the merge tree at that branch's
  // existing blob (no content read — binary-safe, mode preserved from its
  // tree). take-base when planning onto head, take-head onto base.
  | { kind: 'take-base'; path: string }
  | { kind: 'take-head'; path: string }
  // Removal on the incoming side only: null-sha tree entry.
  | { kind: 'delete'; path: string }
  // Changed on both sides: needs diff3 (clean auto-merge or user resolution).
  // addAdd marks add/add pairs, whose merge base is the empty file. The blob
  // SHAs are each tip's version when the change lists carried them.
  | {
      kind: 'merge';
      path: string;
      addAdd: boolean;
      baseBlob?: string;
      headBlob?: string;
    }
  | { kind: 'unsupported'; path: string; reason: string };

export interface MergeInputs {
  // compare(mergeBase → base tip).files. When planning onto base, only
  // entries at the pull's paths (see mergePaths) matter.
  baseChanges: readonly CompareFile[];
  // compare(mergeBase → head tip).files
  headChanges: readonly CompareFile[];
}

// Which branch's tree the merge commit starts from.
export type MergeOnto = 'base' | 'head';

// Every path a change list touches, rename and copy sources included: the
// paths where base's status decides a plan onto base.
export function mergePaths(changes: readonly CompareFile[]): string[] {
  return changes.flatMap((change) =>
    change.previousFilename == null
      ? [change.filename]
      : [change.filename, change.previousFilename]
  );
}

const SIDES = {
  base: { label: 'the base branch', take: 'take-base' },
  head: { label: 'the pull request', take: 'take-head' },
} as const;

export function planMerge(
  { baseChanges, headChanges }: MergeInputs,
  onto: MergeOnto
): MergeFilePlan[] {
  const base = { ...SIDES.base, changes: baseChanges };
  const head = { ...SIDES.head, changes: headChanges };
  const [incoming, existing] = onto === 'head' ? [base, head] : [head, base];
  const incomingSubject = capitalize(incoming.label);
  const existingSubject = capitalize(existing.label);

  // Every path the existing side touched, including rename sources: an
  // incoming change at any of these paths is contested. A rename source is
  // kept apart from a plain removal so an incoming delete of it is still a
  // rename/delete conflict; a copy leaves its source in place and does not
  // mark it at all.
  const existingTouched = new Map<string, ChangeStatus | 'renamed-away'>();
  const existingByPath = new Map<string, CompareFile>();
  for (const change of existing.changes) {
    existingTouched.set(change.filename, change.status);
    existingByPath.set(change.filename, change);
    if (change.status === 'renamed' && change.previousFilename != null) {
      existingTouched.set(change.previousFilename, 'renamed-away');
    }
  }

  const plans: MergeFilePlan[] = [];
  for (const change of incoming.changes) {
    const path = change.filename;
    const existingStatus = existingTouched.get(path);
    const refuse = (why: string) =>
      plans.push({
        kind: 'unsupported',
        path,
        reason: `${why} — resolve with git locally.`,
      });

    if (change.status === 'renamed' || change.status === 'copied') {
      const source = change.previousFilename;
      const sourceContested =
        source != null &&
        existingTouched.has(source) &&
        change.status === 'renamed';
      if (existingStatus != null || sourceContested) {
        refuse(
          `${incomingSubject} ${change.status} this file and ${existing.label} also touches it`
        );
        continue;
      }
      // An uncontested rename/copy is just an add at the new path (plus a
      // delete of the source for renames).
      plans.push({ kind: incoming.take, path });
      if (change.status === 'renamed' && source != null) {
        plans.push({ kind: 'delete', path: source });
      }
      continue;
    }

    if (change.status === 'removed') {
      if (existingStatus == null) {
        plans.push({ kind: 'delete', path });
      } else if (existingStatus === 'removed') {
        // Deleted on both sides — the existing tree already lacks it.
      } else if (existingStatus === 'renamed-away') {
        refuse(
          `${existingSubject} renamed this file but ${incoming.label} deleted it`
        );
      } else {
        refuse(
          `${incomingSubject} deleted this file but ${existing.label} modified it`
        );
      }
      continue;
    }

    if (change.status === 'added' || change.status === 'modified') {
      if (existingStatus == null) {
        plans.push({ kind: incoming.take, path });
      } else if (existingStatus === 'removed') {
        refuse(
          `${existingSubject} deleted this file but ${incoming.label} modified it`
        );
      } else if (existingStatus === 'renamed-away') {
        refuse(
          `${existingSubject} renamed this file while ${incoming.label} changed it`
        );
      } else if (existingStatus === 'renamed' || existingStatus === 'copied') {
        refuse(
          `${existingSubject} ${existingStatus} this file while ${incoming.label} changed it`
        );
      } else if (existingStatus === 'changed') {
        // A text merge would write the incoming side's mode and drop the
        // existing side's type change (e.g. replace its symlink).
        refuse(`The file type changed on ${existing.label}`);
      } else {
        const existingSha = existingByPath.get(path)?.sha;
        const [baseBlob, headBlob] =
          onto === 'head'
            ? [change.sha, existingSha]
            : [existingSha, change.sha];
        plans.push({
          kind: 'merge',
          path,
          addAdd: change.status === 'added',
          ...(baseBlob == null ? {} : { baseBlob }),
          ...(headBlob == null ? {} : { headBlob }),
        });
      }
      continue;
    }

    if (change.status === 'changed') {
      // File-type changes (e.g. file ↔ symlink) are too subtle to merge here.
      if (existingStatus == null) {
        plans.push({ kind: incoming.take, path });
      } else {
        refuse(`The file type changed on ${incoming.label}`);
      }
      continue;
    }
    // 'unchanged' entries need nothing.
  }
  return plans;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    if ('ok' in region) {
      lines.push(...region.ok);
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
