import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  createBlob,
  createCommit,
  createTree,
  createTreeEntryResolver,
  fetchBranchTipSha,
  fetchPullData,
  GitHubCommitError,
  type GitRepoRef,
  type GitTreeWrite,
  type LeafEntry,
  parsePullRefs,
  pollPullMergeable,
  type PullRefs,
  readPullMergeable,
  updateRef,
  waitForPullHead,
} from '@/lib/githubCommitServer';
import { isSameGitHubRepo } from '@/lib/githubDiffSource';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import { createGitHubReads, type GitHubReads } from '@/lib/githubReadCache';
import { diffTrees } from '@/lib/gitTreeDiff';
import { createJSONResponse } from '@/lib/jsonResponse';
import {
  isBinaryContent,
  type MergeOnto,
  mergePaths,
  planMerge,
  renderConflictMarkers,
} from '@/lib/pullMerge';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// Merge-conflict resolution for pull requests.
//
// GET computes the three-way merge server-side: merge base via the compare
// API, diff3 per both-changed file, and git-style conflict markers for the
// files needing a human. The client only calls it when the viewer opens the
// resolver.
//
// POST commits the merge: it re-verifies both branch tips, re-runs the merge
// plan (client-resolved contents are accepted only for genuinely conflicted
// paths; everything else is recomputed server-side), and writes a two-parent
// merge commit to the head branch. Requires the requester's own token.
//
// Immutable reads (compares between SHAs, trees, file contents) go through
// lib/githubReadCache, and every GitHub call through lib/githubFetch's
// per-credential concurrency limit.

const SYMLINK_MODE = '120000';

const SUBMODULE_REASON =
  'This submodule changed on both branches — resolve with git locally.';

type PullMergeContext = PullRefs & {
  baseTreeSha: string;
  headTreeSha: string;
  mergeBaseSha: string;
  // Which branch's tree the merge commit starts from; see planMerge.
  onto: MergeOnto;
  plans: ReturnType<typeof planMerge>;
  reads: GitHubReads;
  // Entry lookups in each commit's tree, sharing planning's tree listings.
  resolveBaseEntry: (path: string) => Promise<LeafEntry | null>;
  resolveHeadEntry: (path: string) => Promise<LeafEntry | null>;
  resolveMergeBaseEntry: (path: string) => Promise<LeafEntry | null>;
};

async function handleGET(request: NextRequest) {
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
  const token = await resolveBearerToken(request);

  try {
    const repoRef = { owner, repo };
    const payload = await pollPullMergeable(repoRef, pull, token);
    if (readPullMergeable(payload) !== false) {
      return createJSONResponse({ conflicted: false });
    }
    // Reading the pull with this token already proved access to its repo.
    const context = await buildMergeContext(
      await resolveLiveBaseTip(parsePullRefs(payload, repoRef), token),
      createGitHubReads(token, { accessibleRepos: [repoRef] })
    );
    const files: {
      conflictCount: number;
      markedContents: string;
      path: string;
    }[] = [];
    const autoMerged: string[] = [];
    const unsupported: { path: string; reason: string }[] = [];
    // diff3 each both-changed file concurrently — every plan needs its own
    // tree lookups and blob reads, so serializing them would stack GitHub
    // round trips.
    // githubFetch bounds how many of those run at once.
    const merged = await Promise.all(
      context.plans.map(async (plan) =>
        plan.kind === 'merge'
          ? ([plan, await runDiff3ForPlan(context, plan)] as const)
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
      } else if (result?.kind === 'submodule') {
        unsupported.push({ path: plan.path, reason: SUBMODULE_REASON });
      } else if (result?.kind === 'text' && result.conflictCount === 0) {
        autoMerged.push(plan.path);
      } else if (result?.kind === 'text') {
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

async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
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
    const refs = await resolveLiveBaseTip(
      parsePullRefs(await fetchPullData(repoRef, body.pull, token), repoRef),
      token
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
    const context = await buildMergeContext(
      refs,
      createGitHubReads(token, { accessibleRepos: [repoRef] })
    );

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
    const { resolveBaseEntry, resolveHeadEntry } = context;

    // Each plan's tree entry is independent (the entry resolvers share the
    // planning listers, so parallel walks stay deduplicated). A merge plan
    // resolves to null when its diff3 recompute still conflicts — the
    // client's view was incomplete, so the whole commit refuses.
    const entries = await Promise.all(
      context.plans.map(async (plan): Promise<GitTreeWrite | null> => {
        if (plan.kind === 'delete') {
          return { mode: '100644', path: plan.path, sha: null };
        }
        if (plan.kind === 'take-base' || plan.kind === 'take-head') {
          const fromBase = plan.kind === 'take-base';
          const entry = await (fromBase ? resolveBaseEntry : resolveHeadEntry)(
            plan.path
          );
          if (entry == null) {
            throw new GitHubCommitError(
              `The ${fromBase ? 'base' : 'head'} branch entry for ${plan.path} could not be resolved.`,
              'github',
              502
            );
          }
          // Submodule gitlinks carry over like files, as type 'commit'.
          return {
            mode: entry.mode,
            path: plan.path,
            sha: entry.sha,
            type: entry.type,
          };
        }
        if (plan.kind !== 'merge') {
          return null;
        }
        const resolved = resolvedByPath.get(plan.path);
        const [existing, merged] = await Promise.all([
          resolveHeadEntry(plan.path),
          resolved == null ? runDiff3ForPlan(context, plan) : undefined,
        ]);
        // GET reports submodules as unsupported; this also refuses
        // client-supplied text for one.
        if (existing?.type === 'commit' || merged?.kind === 'submodule') {
          throw new GitHubCommitError(
            `${plan.path}: ${SUBMODULE_REASON}`,
            'github',
            409
          );
        }
        const contents =
          resolved ??
          (merged?.kind === 'text' && merged.conflictCount === 0
            ? merged.text
            : null);
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
      context.onto === 'head' ? context.headTreeSha : context.baseTreeSha,
      entries.filter((entry) => entry != null)
    );
    const commitSha = await createCommit(context.headRepo, token, {
      message: body.message,
      // Parent order matches `git merge <base>` run on the head branch.
      parents: [context.headSha, context.baseSha],
      treeSha,
    });
    await updateRef(context.headRepo, token, context.headRef, commitSha);
    // Hold the response until GitHub has picked up the new head so the
    // client's reload sees the merged diff rather than the pre-merge one.
    await waitForPullHead(repoRef, body.pull, commitSha, token);
    return createJSONResponse({
      commit: { sha: commitSha },
      headSha: commitSha,
    });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

// Swaps the pull payload's snapshot `base.sha` for the branch's live tip;
// see fetchBranchTipSha for why the payload value cannot be trusted.
async function resolveLiveBaseTip(
  refs: PullRefs,
  token: string | undefined
): Promise<PullRefs> {
  return {
    ...refs,
    baseSha: await fetchBranchTipSha(refs.baseRepo, refs.baseRef, token),
  };
}

// Plans the merge with as few GitHub requests as the branches allow:
//
// 1. The tip compare (base...head) yields the merge base, both root trees, and
//    the pull's own changes (three-dot compares diff from the merge base).
// 2. The base compare (mergeBase...base) lists what the base branch changed.
// 3. The merge is planned onto whichever tip has fewer incoming changes to
//    write: onto head when the base compare is complete and base changed
//    fewer files than the pull (a fresh pull), otherwise onto base (a stale
//    pull against a busy base). Onto base needs base's status only at the
//    pull's paths, so a capped base compare is replaced by a walk of the two
//    base-side trees along just those paths.
//
// A capped pull-side listing (step 1) is replaced by a tree walk of merge
// base vs head, so neither side has a file-count limit.
async function buildMergeContext(
  refs: PullRefs,
  reads: GitHubReads
): Promise<PullMergeContext> {
  const { baseRepo, baseSha, headRepo, headSha } = refs;
  const headSide = isSameGitHubRepo(baseRepo, headRepo)
    ? headSha
    : `${headRepo.owner}:${headSha}`;

  // The head tree depends only on the head commit, so it is read alongside
  // the tip compare rather than after it.
  const [tipCompare, headTreeSha] = await Promise.all([
    reads.compare(baseRepo, `${baseSha}...${headSide}`),
    reads.commitTreeSha(headRepo, headSha),
  ]);
  const { baseTreeSha, mergeBaseSha, mergeBaseTreeSha } = tipCompare;
  if (mergeBaseSha == null || mergeBaseTreeSha == null || baseTreeSha == null) {
    throw new GitHubCommitError(
      'The compare response did not include a merge base.',
      'github',
      502
    );
  }

  // Listers are per repository, so a same-repo pull shares one: the
  // merge-base directories both walks start from are listed once.
  const listBaseTree = reads.treeLister(baseRepo);
  const listHeadTree = reads.treeLister(headRepo);
  // The base compare and (when the pull side capped) the head walk are
  // independent, so they run together.
  const [baseCompare, headChanges] = await Promise.all([
    mergeBaseSha === baseSha
      ? Promise.resolve({ files: [] })
      : reads.compare(baseRepo, `${mergeBaseSha}...${baseSha}`),
    tipCompare.files ?? diffTrees(listHeadTree, mergeBaseTreeSha, headTreeSha),
  ]);

  const onto: MergeOnto =
    baseCompare.files != null && baseCompare.files.length < headChanges.length
      ? 'head'
      : 'base';
  const baseChanges =
    baseCompare.files ??
    (await diffTrees(
      listBaseTree,
      mergeBaseTreeSha,
      baseTreeSha,
      mergePaths(headChanges)
    ));
  return {
    ...refs,
    baseTreeSha,
    headTreeSha,
    mergeBaseSha,
    onto,
    plans: planMerge({ baseChanges, headChanges }, onto),
    reads,
    resolveBaseEntry: createTreeEntryResolver(listBaseTree, baseTreeSha),
    resolveHeadEntry: createTreeEntryResolver(listHeadTree, headTreeSha),
    // The merge base is an ancestor of the base tip, so its trees are in the
    // base repository.
    resolveMergeBaseEntry: createTreeEntryResolver(
      listBaseTree,
      mergeBaseTreeSha
    ),
  };
}

type Diff3Result =
  | { kind: 'binary' | 'submodule' }
  | { conflictCount: number; kind: 'text'; text: string };

// Reads the three versions of a both-changed file. Each tip's version is read
// by the blob SHA its change listing carried, so it stays cached across
// pushes that leave the file alone (a tree lookup stands in when a listing
// lacked the SHA); the merge base's version is read at the merge-base commit,
// which only moves when the base branch is merged in. A missing file reads as
// empty.
//
// Symlinks are the exception: the contents API follows a link to the file it
// names, while a blob read returns the link's target path. A symlink's merge
// base is therefore read by blob SHA from the merge-base tree, so diff3
// compares three target paths.
//
// Compare listings carry no modes, so this is also where a submodule changed
// on both sides is caught, from the head tree entry looked up alongside the
// reads: its gitlink has no text to merge.
async function runDiff3ForPlan(
  context: PullMergeContext,
  plan: {
    addAdd: boolean;
    baseBlob?: string;
    headBlob?: string;
    path: string;
  }
): Promise<Diff3Result> {
  const { reads } = context;
  const readTip = async (
    repo: GitRepoRef,
    blobSha: string | undefined,
    resolveEntry: (path: string) => Promise<LeafEntry | null>
  ) => {
    const sha = blobSha ?? (await resolveEntry(plan.path))?.sha;
    return sha == null ? '' : reads.blob(repo, sha);
  };
  const headEntry = context.resolveHeadEntry(plan.path);
  const tips = Promise.all([
    readTip(context.headRepo, plan.headBlob, context.resolveHeadEntry),
    readTip(context.baseRepo, plan.baseBlob, context.resolveBaseEntry),
  ]);
  const mergeBaseAtCommit = plan.addAdd
    ? Promise.resolve('')
    : reads
        .fileAtCommit(context.baseRepo, context.mergeBaseSha, plan.path)
        .then((text) => text ?? '');
  // Started before the head entry is known, so a failure may go unread: a
  // submodule's tip reads fail (a gitlink's SHA names a commit), and a
  // symlink's merge-base read by commit is discarded. Any other failure is
  // rethrown by the awaits below.
  tips.catch(() => undefined);
  mergeBaseAtCommit.catch(() => undefined);
  const entry = await headEntry;
  if (entry?.type === 'commit') {
    return { kind: 'submodule' };
  }
  const [[ours, theirs], base] = await Promise.all([
    tips,
    entry?.mode === SYMLINK_MODE && !plan.addAdd
      ? readTip(context.baseRepo, undefined, context.resolveMergeBaseEntry)
      : mergeBaseAtCommit,
  ]);
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

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
