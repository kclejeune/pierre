import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  createBlob,
  createCommit,
  createTree,
  createTreeEntryResolver,
  fetchGitHubJSON,
  fetchPullData,
  getCommitTreeSha,
  type GitRepoRef,
  type GitTreeWrite,
  parsePullRefs,
  readStringPath,
  updateRef,
  waitForPullHead,
} from '@/lib/githubCommitServer';
import { encodeURLSegment, isSameGitHubRepo } from '@/lib/githubDiffSource';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

// Committing edited files back to a pull request's head branch.
//
// GET is the capability preflight the viewer runs before showing any edit
// affordance: whether the requester's token can land a commit (open pull,
// push access to the head repo — or maintainer_can_modify plus push on the
// base for fork pulls), plus the head sha the commit flow compare-and-swaps
// against.
//
// POST creates one Git Data commit (blobs → tree → commit → non-force ref
// update) containing every edited file. The requester's own token is
// mandatory for both verbs.

interface PullFileWrite {
  contents: string;
  path: string;
}

export interface PullCommitRequestBody {
  expectedHeadSha: string;
  files: PullFileWrite[];
  message: string;
  owner: string;
  pull: string;
  repo: string;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const owner = params.get('owner');
  const repo = params.get('repo');
  const pull = params.get('pull');
  if (owner == null || repo == null || pull == null) {
    return createJSONResponse(
      { error: 'owner, repo, and pull are required.' },
      { status: 400 }
    );
  }
  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null) {
    return createJSONResponse(
      { error: 'A GitHub token is required.' },
      { status: 401 }
    );
  }

  try {
    const data = await fetchPullData({ owner, repo }, pull, token);
    const refs = parsePullRefs(data, { owner, repo });
    if (readStringPath(data, ['state']) !== 'open') {
      return createJSONResponse({
        canCommit: false,
        headSha: refs.headSha,
        reason: 'pull-closed',
      });
    }
    let canPush = await fetchViewerCanPush(refs.headRepo, token);
    const maintainerCanModify =
      typeof data === 'object' &&
      data != null &&
      (data as Record<string, unknown>).maintainer_can_modify === true;
    if (
      !canPush &&
      maintainerCanModify &&
      !isSameGitHubRepo(refs.headRepo, refs.baseRepo)
    ) {
      canPush = await fetchViewerCanPush(refs.baseRepo, token);
    }
    return createJSONResponse({
      canCommit: canPush,
      headSha: refs.headSha,
      ...(canPush ? {} : { reason: 'no-push-access' }),
    });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null) {
    return createJSONResponse(
      { error: 'A GitHub token is required to commit.' },
      { status: 401 }
    );
  }
  let body: PullCommitRequestBody;
  try {
    body = (await request.json()) as PullCommitRequestBody;
  } catch {
    return createJSONResponse(
      { error: 'The request body must be JSON.' },
      { status: 400 }
    );
  }
  const invalid = validateCommitBody(body);
  if (invalid != null) {
    return createJSONResponse({ error: invalid }, { status: 400 });
  }

  try {
    const repo = { owner: body.owner, repo: body.repo };
    const refs = parsePullRefs(
      await fetchPullData(repo, body.pull, token),
      repo
    );
    if (refs.headSha !== body.expectedHeadSha) {
      return createJSONResponse(
        {
          code: 'stale-head',
          error:
            'The pull request branch moved since this diff was loaded. Reload and re-apply your edits.',
        },
        { status: 409 }
      );
    }

    const headRepo = refs.headRepo;
    const headTreeSha = await getCommitTreeSha(headRepo, token, refs.headSha);
    const resolveEntry = createTreeEntryResolver(headRepo, token);
    const entries: GitTreeWrite[] = await Promise.all(
      body.files.map(async (file): Promise<GitTreeWrite> => {
        const [existing, blobSha] = await Promise.all([
          resolveEntry(headTreeSha, file.path),
          createBlob(headRepo, token, file.contents),
        ]);
        return {
          // New files default to a regular blob; existing ones keep their
          // mode so the executable bit survives.
          mode: existing?.mode ?? '100644',
          path: file.path,
          sha: blobSha,
        };
      })
    );
    const treeSha = await createTree(headRepo, token, headTreeSha, entries);
    const commitSha = await createCommit(headRepo, token, {
      message: body.message,
      parents: [refs.headSha],
      treeSha,
    });
    await updateRef(headRepo, token, refs.headRef, commitSha);
    // Hold the response until GitHub has picked up the new head so the
    // client's reload sees the committed diff rather than the previous one.
    await waitForPullHead(repo, body.pull, commitSha, token);
    return createJSONResponse({
      commit: { sha: commitSha },
      headSha: commitSha,
    });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

function validateCommitBody(body: PullCommitRequestBody): string | undefined {
  if (
    typeof body.owner !== 'string' ||
    typeof body.repo !== 'string' ||
    typeof body.pull !== 'string' ||
    body.owner === '' ||
    body.repo === '' ||
    body.pull === ''
  ) {
    return 'owner, repo, and pull are required.';
  }
  if (typeof body.expectedHeadSha !== 'string' || body.expectedHeadSha === '') {
    return 'expectedHeadSha is required.';
  }
  if (typeof body.message !== 'string' || body.message.trim() === '') {
    return 'A commit message is required.';
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return 'At least one file is required.';
  }
  for (const file of body.files) {
    if (
      typeof file !== 'object' ||
      file == null ||
      typeof file.path !== 'string' ||
      typeof file.contents !== 'string' ||
      !isSafeRepoPath(file.path)
    ) {
      return 'Each file needs a repository-relative path and string contents.';
    }
  }
  return undefined;
}

// Repository-relative path with no traversal or absolute segments.
function isSafeRepoPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\0')) {
    return false;
  }
  return path
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function fetchViewerCanPush(
  repo: GitRepoRef,
  token: string
): Promise<boolean> {
  const data = await fetchGitHubJSON(
    `/repos/${encodeURLSegment(repo.owner)}/${encodeURLSegment(repo.repo)}`,
    token
  );
  return (
    typeof data === 'object' &&
    data != null &&
    typeof (data as Record<string, unknown>).permissions === 'object' &&
    (data as { permissions?: { push?: unknown } }).permissions?.push === true
  );
}
