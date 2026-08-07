'use client';

import { useStableCallback } from '@pierre/diffs/react';
import type { FileTree as FileTreeModel } from '@pierre/trees';
import { useFileTree } from '@pierre/trees/react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { AppNavbar } from './AppNavbar';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { themeController } from './themeController';
import { ThemedCodeView } from './ThemedCodeView';
import { ThemedFileTree } from './ThemedFileTree';
import { ThemeSourceProvider } from './ThemeSourceProvider';
import { useGitHubToken } from './useGitHubToken';
import { useIsWorkerPoolReadyOrDisabled } from './useIsWorkerPoolReadyOrDisabled';
import {
  BASE_FILE_TREE_OPTIONS,
  CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
  FILE_TREE_DENSITY_STYLES,
} from '@/lib/constants';
import { encodePath } from '@/lib/githubDiffSource';
import {
  buildBrowseBlobPath,
  buildBrowseTreePath,
  fetchRepoFile,
  fetchRepoTree,
  type RepoFileData,
  type RepoTreeData,
} from '@/lib/repoBrowser';

interface BrowseUIProps {
  owner: string;
  repo: string;
  view: 'tree' | 'blob';
  refAndPath: string;
}

// The repo file browser: a plain tree of the repository at a ref with a
// syntax-highlighted read-only file pane. Deliberately much simpler than the
// diff viewer — no annotations, comments, or edit flows — it exists so links
// into a repository (rendered-doc references, hand-typed /owner/repo URLs)
// land somewhere native instead of on the GitHub instance.
export function BrowseUI(props: BrowseUIProps) {
  return (
    <ThemeSourceProvider controller={themeController}>
      <BrowseUIInner {...props} />
    </ThemeSourceProvider>
  );
}

type TreeState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RepoTreeData };

function BrowseUIInner({ owner, repo, view, refAndPath }: BrowseUIProps) {
  const tokenState = useGitHubToken();
  const token = tokenState.token === '' ? undefined : tokenState.token;
  const { webURL } = useGitHubEnvironment();
  const workerPoolReady = useIsWorkerPoolReadyOrDisabled();
  // Matches the viewer's theme gating: the CodeView only mounts after the
  // persisted theme selection has applied on the client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [treeState, setTreeState] = useState<TreeState>({ kind: 'loading' });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const treeData = treeState.kind === 'ready' ? treeState.data : null;

  useEffect(() => {
    if (!tokenState.hydrated) {
      return;
    }
    const controller = new AbortController();
    setTreeState({ kind: 'loading' });
    fetchRepoTree({ owner, repo }, refAndPath, token, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setTreeState({ kind: 'ready', data });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setTreeState({
            kind: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Loading the repository tree failed.',
          });
        }
      }
    );
    return () => {
      controller.abort();
    };
  }, [owner, repo, refAndPath, tokenState.hydrated, token]);

  // Open the file the URL names once the listing has resolved the ref/path
  // split. Tree URLs start with nothing selected.
  useEffect(() => {
    if (treeState.kind === 'ready' && view === 'blob') {
      setSelectedPath(treeState.data.path === '' ? null : treeState.data.path);
    }
  }, [treeState, view]);

  // Selecting a file rewrites the URL to its canonical blob form without a
  // navigation; back/forward restore the selection the same way.
  const handleSelectFile = useCallback(
    (path: string) => {
      setSelectedPath(path);
      if (treeData != null) {
        window.history.pushState(
          null,
          '',
          buildBrowseBlobPath({ owner, repo }, treeData.ref, path)
        );
      }
    },
    [owner, repo, treeData]
  );
  useEffect(() => {
    if (treeData == null) {
      return;
    }
    const onPopState = () => {
      const blobPrefix = buildBrowseBlobPath({ owner, repo }, treeData.ref, '');
      const { pathname } = window.location;
      if (pathname.startsWith(blobPrefix)) {
        const path = decodeURIComponent(pathname.slice(blobPrefix.length));
        setSelectedPath(path === '' ? null : path);
        return;
      }
      // The history entry predates this browser instance (a different repo,
      // ref, or page); a real navigation is the only correct restore.
      window.location.reload();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [owner, repo, treeData]);

  const repoSlug = encodePath(`${owner}/${repo}`);
  // The GitHub-instance URL for what is currently on screen, for the header's
  // escape hatch. Browse paths mirror GitHub's URL grammar, so prefixing the
  // instance origin onto the same path yields the matching GitHub link.
  const githubURL =
    treeData == null
      ? `${webURL}/${repoSlug}`
      : selectedPath != null
        ? `${webURL}${buildBrowseBlobPath({ owner, repo }, treeData.ref, selectedPath)}`
        : `${webURL}${buildBrowseTreePath({ owner, repo }, treeData.ref)}`;

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <AppNavbar tokenState={tokenState} />
      <div className="border-border text-foreground flex items-center gap-2 border-b px-4 py-2 font-sans text-[13px]">
        <a className="hover:underline" href={`/${repoSlug}`}>
          {owner}/{repo}
        </a>
        {treeData != null && (
          <span className="border-border bg-muted text-muted-foreground rounded-md border px-1.5 py-0.5 font-mono text-[11px]">
            {treeData.ref}
          </span>
        )}
        {selectedPath != null && (
          <span className="text-muted-foreground truncate font-mono text-[12px]">
            {selectedPath}
          </span>
        )}
        <span className="flex-1" />
        {treeData?.truncated === true && (
          <span className="text-muted-foreground text-[12px]">
            Large repository — file list truncated.
          </span>
        )}
        <a
          className="text-muted-foreground hover:text-foreground whitespace-nowrap hover:underline"
          href={githubURL}
          rel="noreferrer noopener"
          target="_blank"
        >
          Open on GitHub
        </a>
      </div>
      <div className="flex min-h-0 flex-1">
        {treeState.kind === 'loading' && (
          <p className="text-muted-foreground m-auto font-sans text-[13px]">
            Loading repository tree…
          </p>
        )}
        {treeState.kind === 'error' && (
          <p className="text-muted-foreground m-auto max-w-md font-sans text-[13px]">
            {treeState.message}
          </p>
        )}
        {treeData != null && (
          <>
            <aside className="border-border hidden w-80 shrink-0 border-r md:block">
              <BrowseFileTree
                paths={treeData.paths}
                revealPath={treeData.path}
                onSelectFile={handleSelectFile}
              />
            </aside>
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              {selectedPath == null ? (
                <p className="text-muted-foreground m-auto font-sans text-[13px]">
                  Select a file to view it.
                </p>
              ) : mounted && workerPoolReady ? (
                <BrowseFileView
                  key={`${treeData.sha}:${selectedPath}`}
                  owner={owner}
                  repo={repo}
                  sha={treeData.sha}
                  path={selectedPath}
                  githubURL={githubURL}
                  token={token}
                />
              ) : null}
            </main>
          </>
        )}
      </div>
    </div>
  );
}

interface BrowseFileTreeProps {
  paths: readonly string[];
  // Path (file or directory) to scroll into view once the tree mounts.
  revealPath: string;
  onSelectFile(path: string): void;
}

// The browse sidebar: unlike the diff tree (which preserves patch order and
// carries git status), this is a plain semantically-sorted listing of every
// file at the commit. Mounted once per listing — the paths are consumed by
// the model's initializer.
const BrowseFileTree = memo(function BrowseFileTree({
  paths,
  revealPath,
  onSelectFile,
}: BrowseFileTreeProps) {
  const modelRef = useRef<FileTreeModel | null>(null);
  const onSelectionChange = useStableCallback(
    (selectedPaths: readonly string[]) => {
      if (selectedPaths.length !== 1) {
        return;
      }
      const [path] = selectedPaths;
      // Directory rows select too; only leaf files open in the pane.
      if (modelRef.current?.getItem(path)?.isDirectory() === false) {
        onSelectFile(path);
      }
    }
  );
  const { model } = useFileTree({
    ...BASE_FILE_TREE_OPTIONS,
    id: 'diffshub-repo-browser-tree',
    presorted: false,
    paths,
    onSelectionChange,
    itemHeight: CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
  });
  modelRef.current = model;
  useEffect(() => {
    if (revealPath !== '') {
      model.scrollToPath(revealPath, { offset: 'center' });
    }
  }, [model, revealPath]);
  return (
    <ThemedFileTree
      className="h-full min-h-0 overflow-auto overscroll-contain"
      model={model}
      reconcileForegroundFromChrome
      style={FILE_TREE_DENSITY_STYLES}
    />
  );
});

type FileState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: RepoFileData };

interface BrowseFileViewProps {
  owner: string;
  repo: string;
  // The commit sha the tree listing resolved; fetching by sha keeps the pane
  // consistent with the listing even if the branch moves meanwhile.
  sha: string;
  path: string;
  githubURL: string;
  token: string | undefined;
}

function BrowseFileView({
  owner,
  repo,
  sha,
  path,
  githubURL,
  token,
}: BrowseFileViewProps) {
  const [state, setState] = useState<FileState>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    fetchRepoFile({ owner, repo }, sha, path, token, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setState({ kind: 'ready', data });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            kind: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Loading the file failed.',
          });
        }
      }
    );
    return () => {
      controller.abort();
    };
  }, [owner, repo, sha, path, token]);

  if (state.kind === 'loading') {
    return (
      <p className="text-muted-foreground m-auto font-sans text-[13px]">
        Loading {path}…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <p className="text-muted-foreground m-auto max-w-md font-sans text-[13px]">
        {state.message}
      </p>
    );
  }
  if (state.data.binary) {
    return (
      <p className="text-muted-foreground m-auto font-sans text-[13px]">
        This file is not renderable text.{' '}
        <a
          className="hover:text-foreground underline"
          href={githubURL}
          rel="noreferrer noopener"
          target="_blank"
        >
          Open it on GitHub
        </a>
        .
      </p>
    );
  }
  return (
    <ThemedCodeView
      className="cv-scrollbar min-h-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain"
      initialItems={[
        {
          id: path,
          type: 'file',
          file: {
            name: path,
            contents: state.data.contents,
            cacheKey: `browse:${owner}/${repo}:${sha}:${path}`,
          },
        },
      ]}
      options={{ overflow: 'scroll' }}
    />
  );
}
