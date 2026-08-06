import {
  buildHeaders,
  pullParams,
  type PullRequestRef,
  requestJSON,
} from './pullCommentsClient';
import { postCommitRequest, type PullCommitResult } from './pullCommitClient';

// Client wrappers for /api/pull-conflicts: conflict detection (with
// server-rendered conflict markers per file) and the two-parent merge
// commit, which shares the pull-commit client's response contract and
// stale-head error.

export interface ConflictedFile {
  conflictCount: number;
  markedContents: string;
  path: string;
}

export type PullConflictsResult =
  | { conflicted: false }
  | {
      autoMerged: string[];
      baseRef: string;
      baseSha: string;
      conflicted: true;
      files: ConflictedFile[];
      headRef: string;
      headSha: string;
      mergeBaseSha: string;
      unsupported: { path: string; reason: string }[];
    };

export async function fetchPullConflicts(
  pull: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullConflictsResult> {
  const payload = await requestJSON(`/api/pull-conflicts?${pullParams(pull)}`, {
    headers: buildHeaders(token),
    signal,
  });
  return payload as PullConflictsResult;
}

export function commitPullMerge(
  pull: PullRequestRef,
  token: string,
  input: {
    expectedBaseSha: string;
    expectedHeadSha: string;
    message: string;
    resolvedFiles: { contents: string; path: string }[];
  }
): Promise<PullCommitResult> {
  return postCommitRequest('/api/pull-conflicts', token, {
    expectedBaseSha: input.expectedBaseSha,
    expectedHeadSha: input.expectedHeadSha,
    message: input.message,
    owner: pull.owner,
    pull: pull.number,
    repo: pull.repo,
    resolvedFiles: input.resolvedFiles,
  });
}
