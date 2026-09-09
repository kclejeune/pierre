import type { ChangeTypes, FileContents } from '@pierre/diffs';
import { createHash } from 'node:crypto';

import {
  encodePath,
  encodeURLSegment,
  type GitHubDiffSource,
  type GitHubRepo,
  isSameGitHubRepo,
  parseGitHubDiffSource,
} from './githubDiffSource';
import {
  createGitHubAPIURL as createEnvironmentAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from './githubEnvironment';
import { parseGitHubJSONBody } from './githubProxyResponse';
import { isGitHubRateLimitResponse } from './githubRateLimit';
import { type PlainFetch } from './plainFetch';
import { createAsyncLRU, credentialCacheScope } from './serverLRU';

const GITHUB_RAW_MEDIA_TYPE = 'application/vnd.github.raw';
const REF_CACHE_TTL_MS = 5 * 60 * 1000;
const FILE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_REF_CACHE_ENTRIES = 256;
const MAX_FILE_CACHE_ENTRIES = 128;
const MAX_FILE_CACHE_BYTES = 32 * 1024 * 1024;

interface GitHubRepoRef extends GitHubRepo {
  ref: string;
}

interface GitHubDiffRefs {
  oldRef?: GitHubRepoRef;
  newRef: GitHubRepoRef;
}

export interface GitHubDiffFileRequest {
  name: string;
  // Blob object IDs the patch's `index` line recorded for each side, when the
  // client parsed them. They identify the exact content the rendered patch was
  // built from, which is what lets a stale ref resolution be detected below.
  newObjectId?: string;
  path: string;
  prevName?: string;
  prevObjectId?: string;
  type: ChangeTypes;
}

interface LoadedDiffFiles {
  oldFile: FileContents | null;
  newFile: FileContents | null;
}

export class GitHubDiffChangedError extends Error {
  constructor() {
    super(
      'The diff changed while its file contents were loading. Reload and try again.'
    );
    this.name = 'GitHubDiffChangedError';
  }
}

interface GitHubDiffFileServerOptions {
  fetch?: PlainFetch;
  token?: string;
  // Set when `token` came from the viewer's own request. Only such a credential
  // may spend the authenticated Contents API quota, which is what reaches
  // private repositories; anything else reads the anonymous raw host.
  tokenFromRequest?: boolean;
}

const refsCache = createAsyncLRU<string, GitHubDiffRefs>({
  maxEntries: MAX_REF_CACHE_ENTRIES,
  ttlMs: REF_CACHE_TTL_MS,
});
const fileCache = createAsyncLRU<string, FileContents>({
  maxEntries: MAX_FILE_CACHE_ENTRIES,
  maxWeight: MAX_FILE_CACHE_BYTES,
  ttlMs: FILE_CACHE_TTL_MS,
  // JavaScript strings use up to two bytes per UTF-16 code unit. This is an
  // intentionally conservative approximation; object overhead is bounded by
  // the entry cap.
  weight: (file) => file.contents.length * 2,
});

export async function loadGitHubDiffFiles(
  request: GitHubDiffFileRequest,
  options: GitHubDiffFileServerOptions = {}
): Promise<LoadedDiffFiles> {
  const source = parseGitHubDiffSource(request.path);
  if (source == null) {
    throw new Error('Unsupported GitHub diff path.');
  }

  const fetcher = options.fetch ?? fetch;
  const cacheScope = credentialCacheScope(options.token);
  // The fetcher, credential options, and cache scope are the same for every
  // file this request touches, so bind them once and let each case below name
  // only what varies: the ref and path to read.
  const loadFile = (repoRef: GitHubRepoRef, path: string) =>
    loadCachedGitHubFile(repoRef, path, fetcher, options, cacheScope);
  const verifyRefsAndLoad = (
    load: (refs: GitHubDiffRefs) => Promise<LoadedDiffFiles>
  ) =>
    loadWithVerifiedRefs(source, fetcher, options, cacheScope, request, load);
  switch (request.type) {
    case 'new':
      return {
        oldFile: null,
        newFile: createEmptyFallbackFile(request.name, 'new'),
      };
    case 'deleted':
      return {
        oldFile: createEmptyFallbackFile(request.name, 'deleted'),
        newFile: null,
      };
    case 'change':
    case 'rename-changed': {
      const oldPath = request.prevName ?? request.name;
      return verifyRefsAndLoad(async (refs) => {
        const [oldFile, newFile] = await Promise.all([
          loadFile(requireOldRef(request.name, refs), oldPath),
          loadFile(refs.newRef, request.name),
        ]);
        return { oldFile, newFile };
      });
    }
    case 'rename-pure':
      return verifyRefsAndLoad(async (refs) => ({
        oldFile: null,
        newFile: await loadFile(refs.newRef, request.name),
      }));
  }
}

// Hydration must not pair a freshly loaded patch with file contents from an
// older commit. The refs behind a mutable source (a pull's head, a branch
// compare) are cached for minutes, so a diff rendered after the head moved can
// arrive here while the cached resolution still names the previous commit —
// producing a patch and file bodies that disagree.
//
// A git blob ID is a SHA-1 over the content, so the patch's recorded object IDs
// can be checked against the bytes actually fetched without another API call.
// A mismatch on a cached resolution may mean the refs moved: drop them and
// resolve once more. A mismatch on a fresh resolution means the patch and the
// current ref no longer describe the same contents, so fail rather than
// hydrating the rendered patch with unrelated lines.
async function loadWithVerifiedRefs(
  source: GitHubDiffSource,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions,
  cacheScope: string,
  request: GitHubDiffFileRequest,
  load: (refs: GitHubDiffRefs) => Promise<LoadedDiffFiles>
): Promise<LoadedDiffFiles> {
  const cacheKey = refsCacheKey(cacheScope, source);
  const servedFromCache = refsCache.has(cacheKey);
  const files = await load(
    await resolveCachedGitHubDiffRefs(source, fetcher, options, cacheScope)
  );
  if (matchesRecordedObjectIds(files, request)) {
    return files;
  }
  if (servedFromCache) {
    refsCache.delete(cacheKey);
    const refreshed = await load(
      await resolveCachedGitHubDiffRefs(source, fetcher, options, cacheScope)
    );
    if (matchesRecordedObjectIds(refreshed, request)) {
      return refreshed;
    }
  }
  throw new GitHubDiffChangedError();
}

// True unless a side the patch recorded an object ID for came back with
// different content. Sides the client did not describe cannot be checked and so
// never report a mismatch.
function matchesRecordedObjectIds(
  files: LoadedDiffFiles,
  request: GitHubDiffFileRequest
): boolean {
  return (
    matchesObjectId(files.oldFile, request.prevObjectId) &&
    matchesObjectId(files.newFile, request.newObjectId)
  );
}

// GitHub abbreviates the object IDs in a patch's `index` line, so the recorded
// value is compared as a prefix. Very short values are ignored: they carry too
// little information to distinguish a moved ref from a coincidence.
const MIN_COMPARABLE_OBJECT_ID_LENGTH = 7;

function matchesObjectId(
  file: FileContents | null,
  objectId: string | undefined
): boolean {
  if (file == null || objectId == null) {
    return true;
  }
  const expected = objectId.trim().toLowerCase();
  if (
    expected.length < MIN_COMPARABLE_OBJECT_ID_LENGTH ||
    !/^[0-9a-f]+$/.test(expected)
  ) {
    return true;
  }
  return gitBlobId(file.contents).startsWith(expected);
}

// The git object ID of a blob: SHA-1 over the header `blob <byteLength>\0`
// followed by the content bytes, exactly as `git hash-object` computes it.
function gitBlobId(contents: string): string {
  const bytes = Buffer.from(contents, 'utf8');
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

export function clearGitHubDiffFileServerCache(): void {
  refsCache.clear();
  fileCache.clear();
}

// Streams a repository file (e.g. an image referenced by a rendered markdown
// document) at the diff's resolved ref for the given side. Serves <img>
// requests; GitHubAssetImage forwards the viewer's bearer token when one is
// saved, and the fetch is anonymous otherwise (public repos only).
export async function loadGitHubDiffAssetResponse(
  request: {
    file: string;
    path: string;
    side: 'old' | 'new';
  },
  options: GitHubDiffFileServerOptions = {}
): Promise<Response> {
  const source = parseGitHubDiffSource(request.path);
  if (source == null) {
    throw new Error('Unsupported GitHub diff path.');
  }
  // A rendered doc can reference many images, and each arrives as its own
  // request — cache the ref resolution so they don't each re-run the GitHub
  // API calls. Refs are partitioned by a credential digest so one viewer's
  // resolution of a private diff is never served to another viewer.
  const refs = await resolveCachedGitHubDiffRefs(
    source,
    fetch,
    options,
    credentialCacheScope(options.token)
  );
  const ref = request.side === 'old' ? refs.oldRef : refs.newRef;
  if (ref == null) {
    throw new Error('The diff has no old side to load assets from.');
  }
  return fetchGitHubFileContents(
    ref,
    request.file.replace(/^\/+/, ''),
    fetch,
    options
  );
}

function refsCacheKey(cacheScope: string, source: GitHubDiffSource): string {
  return `${cacheScope}\0${getSourceCacheKey(source)}`;
}

function resolveCachedGitHubDiffRefs(
  source: GitHubDiffSource,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions,
  cacheScope: string
): Promise<GitHubDiffRefs> {
  return refsCache.getOrCreate(refsCacheKey(cacheScope, source), () =>
    resolveGitHubDiffRefs(source, fetcher, options)
  );
}

function loadCachedGitHubFile(
  repoRef: GitHubRepoRef,
  path: string,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions,
  cacheScope: string
): Promise<FileContents> {
  const normalizedPath = path.replace(/^\/+/, '');
  const cacheKey = `${cacheScope}\0${repoRef.owner}/${repoRef.repo}\0${repoRef.ref}\0${normalizedPath}`;
  return fileCache.getOrCreate(cacheKey, () =>
    fetchGitHubFile(repoRef, normalizedPath, fetcher, options)
  );
}

async function resolveGitHubDiffRefs(
  source: GitHubDiffSource,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions
): Promise<GitHubDiffRefs> {
  switch (source.kind) {
    case 'pull':
      return resolveGitHubPullRefs(
        source.repo,
        source.number,
        fetcher,
        options
      );
    case 'commit':
      return resolveGitHubCommitRefs(source.repo, source.sha, fetcher, options);
    case 'compare':
      return resolveGitHubCompareRefs(
        source.repo,
        source.range,
        fetcher,
        options
      );
  }
}

async function resolveGitHubPullRefs(
  repo: GitHubRepo,
  number: string,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions
): Promise<GitHubDiffRefs> {
  const data = await fetchGitHubJSON(
    createEnvironmentAPIURL(
      getGitHubEnvironment(),
      `/repos/${encodeURLSegment(repo.owner)}/${encodeURLSegment(repo.repo)}/pulls/${encodeURLSegment(number)}`
    ),
    fetcher,
    options
  );
  const baseSha = readStringPath(data, ['base', 'sha']);
  const headSha = readStringPath(data, ['head', 'sha']);
  const baseRepo = readRepoFullName(data, ['base', 'repo', 'full_name']);
  const headRepo = readRepoFullName(data, ['head', 'repo', 'full_name']);

  if (baseSha == null || headSha == null) {
    throw new Error(
      `GitHub pull ${repo.owner}/${repo.repo}#${number} did not include refs.`
    );
  }

  const oldRepo = baseRepo ?? repo;
  const newRepo = headRepo ?? repo;
  const mergeBaseSha = await resolveGitHubPullMergeBaseSha(
    oldRepo,
    newRepo,
    baseSha,
    headSha,
    fetcher,
    options
  );

  return {
    oldRef: { ...oldRepo, ref: mergeBaseSha },
    newRef: { ...newRepo, ref: headSha },
  };
}

async function resolveGitHubPullMergeBaseSha(
  baseRepo: GitHubRepo,
  headRepo: GitHubRepo,
  baseSha: string,
  headSha: string,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions
): Promise<string> {
  const compareRange = createGitHubCompareRange(
    baseRepo,
    headRepo,
    baseSha,
    headSha
  );
  const data = await fetchGitHubJSON(
    createEnvironmentAPIURL(
      getGitHubEnvironment(),
      `/repos/${encodeURLSegment(baseRepo.owner)}/${encodeURLSegment(baseRepo.repo)}/compare/${encodeURLSegment(compareRange)}`
    ),
    fetcher,
    options
  );
  const mergeBaseSha = readStringPath(data, ['merge_base_commit', 'sha']);
  if (mergeBaseSha == null) {
    throw new Error(
      `GitHub compare ${baseRepo.owner}/${baseRepo.repo}@${compareRange} did not include a merge base.`
    );
  }
  return mergeBaseSha;
}

function createGitHubCompareRange(
  baseRepo: GitHubRepo,
  headRepo: GitHubRepo,
  baseSha: string,
  headSha: string
): string {
  if (isSameGitHubRepo(baseRepo, headRepo)) {
    return `${baseSha}...${headSha}`;
  }
  return `${baseRepo.owner}:${baseSha}...${headRepo.owner}:${headSha}`;
}

async function resolveGitHubCommitRefs(
  repo: GitHubRepo,
  sha: string,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions
): Promise<GitHubDiffRefs> {
  const data = await fetchGitHubJSON(
    createEnvironmentAPIURL(
      getGitHubEnvironment(),
      `/repos/${encodeURLSegment(repo.owner)}/${encodeURLSegment(repo.repo)}/commits/${encodeURLSegment(sha)}`
    ),
    fetcher,
    options
  );
  const resolvedSha = readStringPath(data, ['sha']);
  const parentSha = readFirstParentSha(data);
  if (resolvedSha == null) {
    throw new Error(
      `GitHub commit ${repo.owner}/${repo.repo}@${sha} did not include a SHA.`
    );
  }

  return {
    oldRef: parentSha == null ? undefined : { ...repo, ref: parentSha },
    newRef: { ...repo, ref: resolvedSha },
  };
}

async function resolveGitHubCompareRefs(
  repo: GitHubRepo,
  range: string,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions
): Promise<GitHubDiffRefs> {
  const data = await fetchGitHubJSON(
    createEnvironmentAPIURL(
      getGitHubEnvironment(),
      `/repos/${encodeURLSegment(repo.owner)}/${encodeURLSegment(repo.repo)}/compare/${encodeURLSegment(range)}`
    ),
    fetcher,
    options
  );
  const baseSha = readStringPath(data, ['base_commit', 'sha']);
  const headSha = await readCompareHeadSha(repo, range, data, fetcher, options);

  if (baseSha == null || headSha == null) {
    throw new Error(
      `GitHub compare ${repo.owner}/${repo.repo}@${range} did not include refs.`
    );
  }

  return {
    oldRef: { ...repo, ref: baseSha },
    newRef: { ...repo, ref: headSha },
  };
}

async function readCompareHeadSha(
  repo: GitHubRepo,
  range: string,
  data: unknown,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions
): Promise<string | undefined> {
  const commits = readArrayPath(data, ['commits']);
  const totalCommits = readNumberPath(data, ['total_commits']);
  if (commits == null || commits.length === 0) {
    return undefined;
  }

  if (totalCommits == null || commits.length >= totalCommits) {
    return readStringPath(commits[commits.length - 1], ['sha']);
  }

  const lastPageData = await fetchGitHubJSON(
    createEnvironmentAPIURL(
      getGitHubEnvironment(),
      `/repos/${encodeURLSegment(repo.owner)}/${encodeURLSegment(repo.repo)}/compare/${encodeURLSegment(range)}`,
      { page: String(totalCommits), per_page: '1' }
    ),
    fetcher,
    options
  );
  const lastPageCommits = readArrayPath(lastPageData, ['commits']);
  const lastCommit = lastPageCommits?.[0];
  return lastCommit == null ? undefined : readStringPath(lastCommit, ['sha']);
}

async function fetchGitHubFile(
  repoRef: GitHubRepoRef,
  path: string,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions
): Promise<FileContents> {
  const response = await fetchGitHubFileContents(
    repoRef,
    path,
    fetcher,
    options
  );
  return {
    name: path,
    contents: await response.text(),
    cacheKey: `github:${repoRef.owner}/${repoRef.repo}:${repoRef.ref}:${path}`,
  };
}

// Raw file contents at a ref: the contents API when acting with a request
// token (private-repo access), the raw host anonymously otherwise. Also
// consumed by the repo browser's file loader.
export async function fetchGitHubFileContents(
  repoRef: GitHubRepoRef,
  path: string,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions
): Promise<Response> {
  if (options.tokenFromRequest === true && options.token != null) {
    const url = createEnvironmentAPIURL(
      getGitHubEnvironment(),
      `/repos/${encodeURLSegment(repoRef.owner)}/${encodeURLSegment(repoRef.repo)}/contents/${encodePath(path)}`,
      { ref: repoRef.ref }
    );
    const response = await fetcher(url, {
      headers: createGitHubRawAPIHeaders(options.token),
    });
    await assertGitHubResponseOK(
      response,
      `GitHub contents file ${repoRef.owner}/${repoRef.repo}/${path}@${repoRef.ref}`
    );
    return response;
  }

  const url = `${getGitHubEnvironment().rawURL}/${encodeURLSegment(repoRef.owner)}/${encodeURLSegment(repoRef.repo)}/${encodeURLSegment(repoRef.ref)}/${encodePath(path)}`;
  const response = await fetcher(url, {
    headers: createGitHubRawHeaders(options.token),
  });
  await assertGitHubResponseOK(
    response,
    `GitHub raw file ${repoRef.owner}/${repoRef.repo}/${path}@${repoRef.ref}`
  );
  return response;
}

async function fetchGitHubJSON(
  url: string,
  fetcher: PlainFetch,
  options: GitHubDiffFileServerOptions
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: createGitHubJSONHeaders(options.token),
  });
  await assertGitHubResponseOK(response, `GitHub API ${url}`);
  const body = await parseGitHubJSONBody(response);
  if (body.problem != null) {
    throw new Error(`GitHub API ${url}: ${body.problem}`);
  }
  return body.data;
}

export function createGitHubRawHeaders(token: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    'User-Agent': GITHUB_USER_AGENT,
  };
  if (token != null && token !== '') {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// Headers for the contents API's raw media type; also used by the
// pull-conflicts route to fetch file contents at the three merge refs.
export function createGitHubRawAPIHeaders(
  token: string | undefined
): HeadersInit {
  const headers: Record<string, string> = {
    Accept: GITHUB_RAW_MEDIA_TYPE,
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  if (token != null && token !== '') {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function assertGitHubResponseOK(
  response: Response,
  label: string
): Promise<void> {
  if (response.ok) {
    return;
  }

  const detail = (await response.text()).trim();
  if (isGitHubRateLimitResponse(response, detail)) {
    throw new Error(
      'GitHub rate limit exceeded. Add a GitHub token in DiffsHub settings to raise the limit.'
    );
  }

  throw new Error(
    detail.length > 0
      ? `${label} failed (${response.status}): ${detail}`
      : `${label} failed (${response.status}).`
  );
}

function requireOldRef(name: string, refs: GitHubDiffRefs): GitHubRepoRef {
  if (refs.oldRef == null) {
    throw new Error(`GitHub loader cannot hydrate old file for ${name}.`);
  }
  return refs.oldRef;
}

function createEmptyFallbackFile(
  name: string,
  side: 'deleted' | 'new'
): FileContents {
  return {
    name,
    contents: '',
    cacheKey: `github-empty:${side}:${name}`,
  };
}

function getSourceCacheKey(source: GitHubDiffSource): string {
  switch (source.kind) {
    case 'pull':
      return `pull:${source.repo.owner}/${source.repo.repo}#${source.number}`;
    case 'commit':
      return `commit:${source.repo.owner}/${source.repo.repo}@${source.sha}`;
    case 'compare':
      return `compare:${source.repo.owner}/${source.repo.repo}@${source.range}`;
  }
}

function readRepoFullName(
  data: unknown,
  path: readonly string[]
): GitHubRepo | undefined {
  const fullName = readStringPath(data, path);
  if (fullName == null) {
    return undefined;
  }

  const separatorIndex = fullName.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === fullName.length - 1) {
    return undefined;
  }
  return {
    owner: fullName.slice(0, separatorIndex),
    repo: fullName.slice(separatorIndex + 1),
  };
}

function readFirstParentSha(data: unknown): string | undefined {
  const parents = readArrayPath(data, ['parents']);
  const firstParent = parents?.[0];
  return firstParent == null ? undefined : readStringPath(firstParent, ['sha']);
}

function readStringPath(
  data: unknown,
  path: readonly string[]
): string | undefined {
  const value = readUnknownPath(data, path);
  return typeof value === 'string' ? value : undefined;
}

function readNumberPath(
  data: unknown,
  path: readonly string[]
): number | undefined {
  const value = readUnknownPath(data, path);
  return typeof value === 'number' ? value : undefined;
}

function readArrayPath(
  data: unknown,
  path: readonly string[]
): unknown[] | undefined {
  const value = readUnknownPath(data, path);
  return Array.isArray(value) ? value : undefined;
}

function readUnknownPath(data: unknown, path: readonly string[]): unknown {
  let current = data;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
