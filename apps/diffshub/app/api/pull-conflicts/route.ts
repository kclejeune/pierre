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
  GitHubCommitError,
  type GitRepoRef,
  type GitTreeWrite,
  parsePullRefs,
  type PullRefs,
  updateRef,
} from '@/lib/githubCommitServer';
import { createGitHubRawAPIHeaders } from '@/lib/githubDiffFileServer';
import { encodePath, encodeURLSegment } from '@/lib/githubDiffSource';
import {
  createGitHubAPIURL,
  getGitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
  resolveRequestGitHubToken,
} from '@/lib/githubEnvironment';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';
import {
  type CompareFile,
  isBinaryContent,
  planMerge,
  renderConflictMarkers,
} from '@/lib/pullMerge';

// Merge-conflict resolution for pull requests.
//
// GET detects whether the pull conflicts with its base and, if so, computes
// the three-way merge server-side: merge base via the compare API, diff3 per
// both-changed file, and git-style conflict markers for the files needing a
// human. Reads may use the deployment fallback token.
//
// POST commits the merge: it re-verifies both branch tips, re-runs the merge
// plan (client-resolved contents are accepted only for genuinely conflicted
// paths; everything else is recomputed server-side), and writes a two-parent
// merge commit to the head branch. Requires the requester's own token.

// GitHub caps compare-API file listings at 300 entries; beyond that the
// merge plan would be silently incomplete, so the route refuses instead.
const COMPARE_FILES_CAP = 300;

type PullMergeContext = PullRefs & {
  mergeBaseSha: string;
  plans: ReturnType<typeof planMerge>;
};

export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

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
  const token = resolveRequestGitHubToken(request);

  try {
    const repoRef = { owner, repo };
    const data = await fetchPullDataWithMergeable(repoRef, pull, token);
    if (data.mergeable !== false) {
      return createJSONResponse({ conflicted: false });
    }
    const context = await buildMergeContext(
      parsePullRefs(data.payload, repoRef),
      token
    );
    const files: {
      conflictCount: number;
      markedContents: string;
      path: string;
    }[] = [];
    const autoMerged: string[] = [];
    const unsupported: { path: string; reason: string }[] = [];
    // diff3 each both-changed file concurrently — every plan needs its own
    // contents fetches, so serializing them would stack GitHub round trips.
    const merged = await Promise.all(
      context.plans.map(async (plan) =>
        plan.kind === 'merge'
          ? ([plan, await runDiff3ForPlan(context, plan, token)] as const)
          : ([plan, undefined] as const)
      )
    );
    for (const [plan, result] of merged) {
      if (plan.kind === 'unsupported') {
        unsupported.push({ path: plan.path, reason: plan.reason });
      } else if (result?.kind === 'binary') {
        unsupported.push({
          path: plan.path,
          reason: 'Binary files cannot be merged in DiffsHub.',
        });
      } else if (result != null && result.conflictCount === 0) {
        autoMerged.push(plan.path);
      } else if (result != null) {
        files.push({
          conflictCount: result.conflictCount,
          markedContents: result.text,
          path: plan.path,
        });
      }
    }
    return createJSONResponse({
      autoMerged,
      baseRef: context.baseRef,
      baseSha: context.baseSha,
      conflicted: true,
      files,
      headRef: context.headRef,
      headSha: context.headSha,
      mergeBaseSha: context.mergeBaseSha,
      unsupported,
    });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export interface PullMergeCommitRequestBody {
  expectedBaseSha: string;
  expectedHeadSha: string;
  message: string;
  owner: string;
  pull: string;
  repo: string;
  resolvedFiles: { contents: string; path: string }[];
}

export async function POST(request: NextRequest) {
  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null) {
    return createJSONResponse(
      { error: 'A GitHub token is required to commit a merge.' },
      { status: 401 }
    );
  }
  let body: PullMergeCommitRequestBody;
  try {
    body = (await request.json()) as PullMergeCommitRequestBody;
  } catch {
    return createJSONResponse(
      { error: 'The request body must be JSON.' },
      { status: 400 }
    );
  }
  if (
    typeof body.owner !== 'string' ||
    typeof body.repo !== 'string' ||
    typeof body.pull !== 'string' ||
    typeof body.expectedHeadSha !== 'string' ||
    typeof body.expectedBaseSha !== 'string' ||
    typeof body.message !== 'string' ||
    body.message.trim() === '' ||
    !Array.isArray(body.resolvedFiles) ||
    body.resolvedFiles.some(
      (file) =>
        typeof file !== 'object' ||
        file == null ||
        typeof file.path !== 'string' ||
        typeof file.contents !== 'string'
    )
  ) {
    return createJSONResponse(
      { error: 'The merge request is malformed.' },
      { status: 400 }
    );
  }

  try {
    const repoRef = { owner: body.owner, repo: body.repo };
    const refs = parsePullRefs(
      await fetchPullData(repoRef, body.pull, token),
      repoRef
    );
    if (
      refs.headSha !== body.expectedHeadSha ||
      refs.baseSha !== body.expectedBaseSha
    ) {
      return createJSONResponse(
        {
          code: 'stale-head',
          error:
            'A branch moved while you were resolving. Reload the conflicts and try again.',
        },
        { status: 409 }
      );
    }
    const context = await buildMergeContext(refs, token);

    const unsupported = context.plans.filter(
      (plan) => plan.kind === 'unsupported'
    );
    if (unsupported.length > 0) {
      return createJSONResponse(
        {
          code: 'unsupported',
          error: `Some changes cannot be merged in DiffsHub: ${unsupported
            .map((plan) => plan.path)
            .join(', ')}`,
        },
        { status: 409 }
      );
    }

    const resolvedByPath = new Map(
      body.resolvedFiles.map((file) => [file.path, file.contents])
    );
    const [headTreeSha, baseTreeSha] = await Promise.all([
      getCommitTreeSha(context.headRepo, token, context.headSha),
      getCommitTreeSha(context.baseRepo, token, context.baseSha),
    ]);
    const resolveHeadEntry = createTreeEntryResolver(context.headRepo, token);
    const resolveBaseEntry = createTreeEntryResolver(context.baseRepo, token);

    // Each plan's tree entry is independent (the entry resolvers memoize
    // directory listings, so parallel walks stay deduplicated). A merge plan
    // resolves to null when its diff3 recompute still conflicts — the
    // client's view was incomplete, so the whole commit refuses.
    const entries = await Promise.all(
      context.plans.map(async (plan): Promise<GitTreeWrite | null> => {
        if (plan.kind === 'delete') {
          return { mode: '100644', path: plan.path, sha: null };
        }
        if (plan.kind === 'take-base') {
          const entry = await resolveBaseEntry(baseTreeSha, plan.path);
          if (entry == null) {
            throw new GitHubCommitError(
              `The base branch entry for ${plan.path} could not be resolved.`,
              'github',
              502
            );
          }
          return { mode: entry.mode, path: plan.path, sha: entry.sha };
        }
        if (plan.kind !== 'merge') {
          return null;
        }
        const resolved = resolvedByPath.get(plan.path);
        const [existing, contents] = await Promise.all([
          resolveHeadEntry(headTreeSha, plan.path),
          resolved != null
            ? Promise.resolve(resolved)
            : runDiff3ForPlan(context, plan, token).then((merged) =>
                merged.kind === 'binary' || merged.conflictCount > 0
                  ? null
                  : merged.text
              ),
        ]);
        if (contents == null) {
          return null;
        }
        return {
          mode: existing?.mode ?? '100644',
          path: plan.path,
          sha: await createBlob(context.headRepo, token, contents),
        };
      })
    );
    const unresolvedIndex = entries.findIndex(
      (entry, index) => entry == null && context.plans[index]?.kind === 'merge'
    );
    if (unresolvedIndex >= 0) {
      return createJSONResponse(
        {
          code: 'unresolved-conflict',
          error: `${context.plans[unresolvedIndex]?.path} still has unresolved conflicts.`,
        },
        { status: 400 }
      );
    }

    const treeSha = await createTree(
      context.headRepo,
      token,
      headTreeSha,
      entries.filter((entry) => entry != null)
    );
    const commitSha = await createCommit(context.headRepo, token, {
      message: body.message,
      // Parent order matches `git merge <base>` run on the head branch.
      parents: [context.headSha, context.baseSha],
      treeSha,
    });
    await updateRef(context.headRepo, token, context.headRef, commitSha);
    return createJSONResponse({
      commit: { sha: commitSha },
      headSha: commitSha,
    });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

// GitHub computes mergeability lazily; a null `mergeable` means "still
// computing", so the GET detection path retries briefly before reporting.
// The POST path skips this — it never reads `mergeable`.
async function fetchPullDataWithMergeable(
  repo: GitRepoRef,
  pull: string,
  token: string | undefined
): Promise<{ mergeable: boolean | null; payload: unknown }> {
  for (let attempt = 0; ; attempt += 1) {
    const payload = await fetchPullData(repo, pull, token);
    const raw =
      typeof payload === 'object' && payload != null
        ? (payload as Record<string, unknown>).mergeable
        : undefined;
    const mergeable = typeof raw === 'boolean' ? raw : null;
    if (mergeable != null || attempt >= 2) {
      return { mergeable, payload };
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

async function buildMergeContext(
  refs: PullRefs,
  token: string | undefined
): Promise<PullMergeContext> {
  const { baseRepo, baseSha, headRepo, headSha } = refs;
  const crossRepo =
    baseRepo.owner.toLowerCase() !== headRepo.owner.toLowerCase() ||
    baseRepo.repo.toLowerCase() !== headRepo.repo.toLowerCase();
  const headSide = crossRepo ? `${headRepo.owner}:${headSha}` : headSha;

  const tipCompare = await fetchCompare(
    baseRepo,
    `${baseSha}...${headSide}`,
    token
  );
  const mergeBaseSha =
    typeof tipCompare === 'object' && tipCompare != null
      ? readMergeBaseSha(tipCompare)
      : undefined;
  if (mergeBaseSha == null) {
    throw new GitHubCommitError(
      'The compare response did not include a merge base.',
      'github',
      502
    );
  }
  const [baseCompare, headCompare] = await Promise.all([
    fetchCompare(baseRepo, `${mergeBaseSha}...${baseSha}`, token),
    fetchCompare(baseRepo, `${mergeBaseSha}...${headSide}`, token),
  ]);
  const baseChanges = readCompareFiles(baseCompare);
  const headChanges = readCompareFiles(headCompare);
  if (
    baseChanges.length >= COMPARE_FILES_CAP ||
    headChanges.length >= COMPARE_FILES_CAP
  ) {
    throw new GitHubCommitError(
      'Too many changed files to merge in DiffsHub — merge with git locally.',
      'github',
      422
    );
  }
  return {
    ...refs,
    mergeBaseSha,
    plans: planMerge({ baseChanges, headChanges }),
  };
}

function readMergeBaseSha(compare: object): string | undefined {
  const mergeBase = (compare as Record<string, unknown>).merge_base_commit;
  const sha =
    typeof mergeBase === 'object' && mergeBase != null
      ? (mergeBase as Record<string, unknown>).sha
      : undefined;
  return typeof sha === 'string' ? sha : undefined;
}

type Diff3Result =
  | { kind: 'binary' }
  | { conflictCount: number; kind: 'text'; text: string };

async function runDiff3ForPlan(
  context: PullMergeContext,
  plan: { addAdd: boolean; path: string },
  token: string | undefined
): Promise<Diff3Result> {
  const [baseContent, oursContent, theirsContent] = await Promise.all([
    plan.addAdd
      ? Promise.resolve('')
      : fetchFileAtRef(
          context.baseRepo,
          context.mergeBaseSha,
          plan.path,
          token
        ),
    fetchFileAtRef(context.headRepo, context.headSha, plan.path, token),
    fetchFileAtRef(context.baseRepo, context.baseSha, plan.path, token),
  ]);
  const base = baseContent ?? '';
  const ours = oursContent ?? '';
  const theirs = theirsContent ?? '';
  if (
    isBinaryContent(base) ||
    isBinaryContent(ours) ||
    isBinaryContent(theirs)
  ) {
    return { kind: 'binary' };
  }
  const rendered = renderConflictMarkers(base, ours, theirs, {
    base: 'merge-base',
    ours: context.headRef,
    theirs: context.baseRef,
  });
  return {
    conflictCount: rendered.conflictCount,
    kind: 'text',
    text: rendered.text,
  };
}

async function fetchFileAtRef(
  repo: GitRepoRef,
  ref: string,
  path: string,
  token: string | undefined
): Promise<string | null> {
  const url = createGitHubAPIURL(
    getGitHubEnvironment(),
    `/repos/${encodeURLSegment(repo.owner)}/${encodeURLSegment(repo.repo)}/contents/${encodePath(path)}`,
    { ref }
  );
  const response = await fetch(url, {
    cache: 'no-store',
    headers: createGitHubRawAPIHeaders(token),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new GitHubCommitError(
      detail === ''
        ? `Fetching ${path}@${ref} failed (${response.status}).`
        : detail,
      'github',
      response.status
    );
  }
  return response.text();
}

function fetchCompare(
  repo: GitRepoRef,
  range: string,
  token: string | undefined
): Promise<unknown> {
  return fetchGitHubJSON(
    `/repos/${encodeURLSegment(repo.owner)}/${encodeURLSegment(repo.repo)}/compare/${encodeURLSegment(range)}`,
    token
  );
}

const COMPARE_STATUSES = new Set([
  'added',
  'changed',
  'copied',
  'modified',
  'removed',
  'renamed',
  'unchanged',
]);

function readCompareFiles(compare: unknown): CompareFile[] {
  const files =
    typeof compare === 'object' && compare != null
      ? (compare as Record<string, unknown>).files
      : undefined;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((file) => {
    if (typeof file !== 'object' || file == null) {
      return [];
    }
    const record = file as Record<string, unknown>;
    const filename = record.filename;
    const status = record.status;
    if (
      typeof filename !== 'string' ||
      typeof status !== 'string' ||
      !COMPARE_STATUSES.has(status)
    ) {
      return [];
    }
    const entry: CompareFile = {
      filename,
      status: status as CompareFile['status'],
    };
    if (typeof record.previous_filename === 'string') {
      entry.previousFilename = record.previous_filename;
    }
    return [entry];
  });
}
