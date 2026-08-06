import {
  APIRequestError,
  buildHeaders,
  pullParams,
  type PullRequestRef,
  requestJSON,
} from './pullCommentsClient';

// Client wrappers for /api/pull-commit: the capability preflight that gates
// edit affordances, and the batch commit itself. Built on the shared
// requestJSON idiom, with a typed stale-head error so the UI can offer a
// reload instead of a generic failure toast. The pull-conflicts client shares
// both the error class and the commit-response contract via
// postCommitRequest.

export interface PullCommitCapability {
  canCommit: boolean;
  // The head sha the preflight observed — the compare-and-swap value for the
  // commit that follows.
  headSha: string;
  reason?: 'no-push-access' | 'pull-closed';
}

export interface PullCommitResult {
  commitSha: string;
  headSha: string;
}

export class PullCommitStaleHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullCommitStaleHeadError';
  }
}

export async function fetchPullCommitCapability(
  pull: PullRequestRef,
  token: string,
  signal?: AbortSignal
): Promise<PullCommitCapability> {
  const payload = await requestJSON(`/api/pull-commit?${pullParams(pull)}`, {
    headers: buildHeaders(token),
    signal,
  });
  return payload as PullCommitCapability;
}

// POSTs a commit-producing route and unwraps the shared {commit, headSha}
// response, mapping the 'stale-head' code onto the typed error.
export async function postCommitRequest(
  url: string,
  token: string,
  body: unknown
): Promise<PullCommitResult> {
  let payload: unknown;
  try {
    payload = await requestJSON(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof APIRequestError && error.code === 'stale-head') {
      throw new PullCommitStaleHeadError(error.message);
    }
    throw error;
  }
  const record = payload as {
    commit?: { sha?: unknown };
    headSha?: unknown;
  } | null;
  const commitSha = record?.commit?.sha;
  const headSha = record?.headSha;
  if (typeof commitSha !== 'string' || typeof headSha !== 'string') {
    throw new Error('The commit response was malformed.');
  }
  return { commitSha, headSha };
}

export function commitPullFiles(
  pull: PullRequestRef,
  token: string,
  input: {
    expectedHeadSha: string;
    files: { contents: string; path: string }[];
    message: string;
  }
): Promise<PullCommitResult> {
  return postCommitRequest('/api/pull-commit', token, {
    expectedHeadSha: input.expectedHeadSha,
    files: input.files,
    message: input.message,
    owner: pull.owner,
    pull: pull.number,
    repo: pull.repo,
  });
}
