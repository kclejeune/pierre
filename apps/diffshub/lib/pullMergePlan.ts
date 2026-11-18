// How a pull request gets merged, decided once for every merge surface: the
// details panel's footer and the /pulls batch bar. Pure, so both read the
// same rules from the same data (the details supplement's capabilities and
// merge queue, and the pull's own draft and conflict state).

import type {
  PullDetails,
  PullMergeCapabilities,
  PullMergeQueueStatus,
} from './pullInfoClient';
import type { PullMergeMethod } from './pullMergeClient';

export type PullMergePlan =
  // Can't merge from here; `message` says why.
  | { kind: 'blocked'; message: string }
  // The base branch has a merge queue, which sets the method.
  | { kind: 'queue' }
  // A direct merge, defaulting to the repository's first allowed method.
  | { kind: 'merge'; method: PullMergeMethod };

export function planPullMerge(
  capabilities: PullMergeCapabilities | null,
  mergeQueue: PullMergeQueueStatus | null
): PullMergePlan {
  if (capabilities == null) {
    return {
      kind: 'blocked',
      message:
        'Merge permissions could not be loaded. Open this pull request on GitHub to merge it.',
    };
  }
  if (!capabilities.canMerge) {
    return {
      kind: 'blocked',
      message:
        'Your GitHub token does not have permission to merge this pull request.',
    };
  }
  if (mergeQueue != null) {
    return { kind: 'queue' };
  }
  const [method] = capabilities.methods;
  return method == null
    ? {
        kind: 'blocked',
        message:
          'This repository does not expose a direct merge method. Use GitHub for repository-specific merge rules.',
      }
    : { kind: 'merge', method };
}

// Why the pull itself can't merge right now, whatever the viewer's access:
// drafts and conflicts. The details panel adds the GitHub App's own refusal.
export function pullMergeBlockedReason(
  details: Pick<PullDetails, 'draft' | 'mergeable'>
): string | null {
  if (details.draft) {
    return 'Draft pull requests cannot be merged.';
  }
  if (details.mergeable === false) {
    return 'This pull request has conflicts with its base branch.';
  }
  return null;
}
