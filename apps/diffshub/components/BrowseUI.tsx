'use client';

import { useStableCallback } from '@pierre/diffs/react';
import { IconBook, IconBrandGithub, IconShare } from '@pierre/icons';
import type { FileTree as FileTreeModel } from '@pierre/trees';
import { useFileTree } from '@pierre/trees/react';
import Link from 'next/link';
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Components } from 'react-markdown';

import { Button } from './Button';
import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { DiffsHubLogo } from './DiffsHubLogo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { GitHubAssetImage } from './GitHubAssetImage';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { GitHubTokenControl } from './GitHubTokenControl';
import {
  DOC_REMARK_PLUGINS,
  MarkdownContent,
  MarkdownImage,
} from './MarkdownContent';
import {
  RefPickerItems,
  RefPickerLabel,
  RefPillArrow,
  RefPillMenu,
  useLazyRepoRefs,
} from './RefPicker';
import { themeController } from './themeController';
import { ThemedCodeView } from './ThemedCodeView';
import { ThemedFileTree } from './ThemedFileTree';
import { ThemeSourceProvider } from './ThemeSourceProvider';
import { useChromeThemeProps } from './useChromeThemeProps';
import { type GitHubTokenState, useGitHubToken } from './useGitHubToken';
import { useGitHubUser } from './useGitHubUser';
import { useIsWorkerPoolReadyOrDisabled } from './useIsWorkerPoolReadyOrDisabled';
import { cn } from '@/lib/cn';
import {
  BASE_FILE_TREE_OPTIONS,
  CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
  FILE_TREE_DENSITY_STYLES,
} from '@/lib/constants';
import {
  loadDisplaySettings,
  saveDisplaySettings,
} from '@/lib/displaySettings';
import { encodePath } from '@/lib/githubDiffSource';
import { isMarkdownFileName } from '@/lib/isMarkdownFileName';
import { isPlainLeftClick } from '@/lib/isPlainLeftClick';
import {
  createDocAssetURL,
  resolveDocAssetPath,
  resolveDocLinkTarget,
} from '@/lib/markdownDocAssets';
import {
  rehypeGitHubHeadingIds,
  scrollToDocFragment,
} from '@/lib/markdownHeadingIds';
import { recordRecentDiff } from '@/lib/recentDiffs';
import {
  buildBrowseBlobPath,
  buildBrowseTreePath,
  buildCommitDiffPath,
  buildComparePath,
  fetchRepoFile,
  fetchRepoTree,
  formatBrowseRecentTitle,
  type RepoFileData,
  type RepoTreeData,
} from '@/lib/repoBrowser';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';
import { getDropdownThemeStyle } from '@/lib/theme/dropdownChromeStyle';

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

  // Shares the diff viewer's persisted rendered/raw markdown preference, so
  // toggling in either surface carries to the other.
  const [markdownView, setMarkdownView] = useState<'rendered' | 'raw'>('raw');
  useEffect(() => {
    const stored = loadDisplaySettings().markdownView;
    if (stored != null) {
      setMarkdownView(stored);
    }
  }, []);
  const toggleMarkdownView = useCallback(() => {
    setMarkdownView((current) => {
      const next = current === 'rendered' ? 'raw' : 'rendered';
      saveDisplaySettings({ ...loadDisplaySettings(), markdownView: next });
      return next;
    });
  }, []);

  // Mirror the diff viewer's chrome: the header and panes live on the active
  // Shiki theme's surfaces instead of the global light/dark palette.
  const { style: chromeStyle } = useChromeThemeProps(diffshubChromeMapping);
  const themeChromeStyle =
    Object.keys(chromeStyle).length > 0 ? chromeStyle : undefined;
  const dropdownThemeStyle = useMemo(
    () => getDropdownThemeStyle(themeChromeStyle),
    [themeChromeStyle]
  );

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

  // Surface visited trees in the launcher's Recent section alongside diffs.
  useEffect(() => {
    if (treeData != null) {
      recordRecentDiff({
        path: buildBrowseTreePath({ owner, repo }, treeData.ref),
        title: formatBrowseRecentTitle({ owner, repo }, treeData.ref),
      });
    }
  }, [owner, repo, treeData]);

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
  // A rendered-document link naming a file in this tree opens it in the pane
  // instead of navigating, same as selecting it in the tree.
  const handleOpenDocFile = useCallback(
    (path: string): boolean => {
      if (treeData == null || !treeData.paths.includes(path)) {
        return false;
      }
      handleSelectFile(path);
      return true;
    },
    [handleSelectFile, treeData]
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
    <div
      className={cn(
        'text-foreground flex h-dvh min-h-0 flex-col',
        themeChromeStyle == null && 'bg-background'
      )}
      style={themeChromeStyle}
    >
      <header className="z-10 flex items-center gap-2.5 border-b border-[var(--color-border-opaque)] px-4 py-1.5 md:px-3">
        <Link
          href="/"
          className="inline-flex transition-transform duration-200 hover:scale-110"
        >
          <DiffsHubLogo />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2 font-sans text-[13px]">
          <a
            className="whitespace-nowrap hover:underline"
            href={`/${repoSlug}`}
          >
            {owner}/{repo}
          </a>
          {treeData != null && (
            <BrowseRefsBadge
              owner={owner}
              repo={repo}
              treeData={treeData}
              dropdownThemeStyle={dropdownThemeStyle}
            />
          )}
          {selectedPath != null && (
            <span className="text-muted-foreground truncate font-mono text-[12px]">
              {selectedPath}
            </span>
          )}
        </div>
        {treeData?.truncated === true && (
          <span className="text-muted-foreground hidden text-[12px] lg:block">
            Large repository — file list truncated.
          </span>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            aria-pressed={markdownView === 'rendered'}
            title={
              markdownView === 'rendered'
                ? 'Show raw markdown'
                : 'Render markdown files'
            }
            className={cn(
              CHROME_ICON_BUTTON_CLASS,
              markdownView === 'rendered' && 'text-foreground bg-muted'
            )}
            onClick={toggleMarkdownView}
          >
            <IconBook className="size-4 md:size-3" />
          </Button>
          <Button
            asChild
            variant="ghost"
            size="icon-md"
            aria-label="Open on GitHub"
            title="Open on GitHub"
            className={CHROME_ICON_BUTTON_CLASS}
          >
            <a href={githubURL} rel="noreferrer noopener" target="_blank">
              <IconShare className="size-4 md:size-3" />
            </a>
          </Button>
          <div className="bg-border h-3 w-px" />
          <BrowseAccountMenu
            dropdownThemeStyle={dropdownThemeStyle}
            tokenState={tokenState}
          />
        </div>
      </header>
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
            <aside className="hidden w-80 shrink-0 border-r border-[var(--color-border-opaque)] md:block">
              <BrowseFileTree
                paths={treeData.paths}
                revealPath={treeData.path}
                onSelectFile={handleSelectFile}
              />
            </aside>
            {/* The code view paints the editor surface only as far as its
                content; carrying the same background on the pane keeps the
                area past the end of a short file consistent. */}
            <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--diffshub-editor-bg,var(--color-background))]">
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
                  markdownView={markdownView}
                  onOpenFile={handleOpenDocFile}
                />
              ) : null}
            </main>
          </>
        )}
      </div>
    </div>
  );
}

// The header's account affordance: the same GitHub token panel the other
// pages offer, behind an avatar (signed in) or GitHub mark, restyled for the
// themed chrome.
function BrowseAccountMenu({
  dropdownThemeStyle,
  tokenState,
}: {
  dropdownThemeStyle: CSSProperties | undefined;
  tokenState: GitHubTokenState;
}) {
  const githubUser = useGitHubUser();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label="GitHub account"
          className={CHROME_ICON_BUTTON_CLASS}
        >
          {githubUser != null ? (
            <CommentAuthorAvatar
              author={githubUser}
              className="size-5 self-center"
            />
          ) : (
            <IconBrandGithub className="size-4 md:size-3" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 p-2"
        style={dropdownThemeStyle}
      >
        <GitHubTokenControl
          active={tokenState.hasToken}
          onClear={tokenState.clearToken}
          onSave={tokenState.setToken}
          title="GitHub access"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The browse header's ref display, the same base/head pill element the diff
// header shows. The head pill names the browsed ref and switches it (or
// opens the head commit's own diff); the base pill starts as a muted
// placeholder and picking a branch opens the GitHub-style compare of this
// ref against it — the compare affordance the old "Diff…" menu provided.
function BrowseRefsBadge({
  owner,
  repo,
  treeData,
  dropdownThemeStyle,
}: {
  owner: string;
  repo: string;
  treeData: RepoTreeData;
  dropdownThemeStyle: CSSProperties | undefined;
}) {
  const repoRef = useMemo(() => ({ owner, repo }), [owner, repo]);
  // One lazy branch listing feeds both pills; either menu's first open
  // triggers the single load.
  const { handleOpenChange, refsState } = useLazyRepoRefs(repoRef);
  return (
    <div
      role="group"
      aria-label={`Browsing ${treeData.ref}`}
      className="flex min-w-0 shrink-0 items-center gap-1 text-xs"
    >
      <RefPillMenu
        kind="base"
        label="choose…"
        placeholder
        ariaLabel={`base: none — pick a ref to compare ${treeData.ref} against`}
        title={`Compare ${treeData.ref} against a base ref`}
        dropdownThemeStyle={dropdownThemeStyle}
        onOpenChange={handleOpenChange}
      >
        <RefPickerLabel>Compare {treeData.ref} against…</RefPickerLabel>
        <RefPickerItems
          refsState={refsState}
          excludeRefs={[treeData.ref]}
          getRefHref={(base) => buildComparePath(repoRef, base, treeData.ref)}
        />
      </RefPillMenu>
      <RefPillArrow />
      <RefPillMenu
        kind="head"
        label={treeData.ref}
        ariaLabel={`head: ${treeData.ref} — switch the browsed ref or view its diff`}
        title="Switch the browsed ref"
        dropdownThemeStyle={dropdownThemeStyle}
        onOpenChange={handleOpenChange}
      >
        <DropdownMenuItem asChild>
          <a href={buildCommitDiffPath(repoRef, treeData.sha)}>
            Commit diff ({treeData.sha.slice(0, 7)})
          </a>
        </DropdownMenuItem>
        <RefPickerLabel>Browse another branch…</RefPickerLabel>
        <RefPickerItems
          refsState={refsState}
          excludeRefs={[treeData.ref]}
          getRefHref={(ref) => buildBrowseTreePath(repoRef, ref)}
        />
      </RefPillMenu>
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
  markdownView: 'rendered' | 'raw';
  onOpenFile(path: string): boolean;
}

function BrowseFileView({
  owner,
  repo,
  sha,
  path,
  githubURL,
  token,
  markdownView,
  onOpenFile,
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
  if (isMarkdownFileName(path) && markdownView === 'rendered') {
    return (
      <BrowseMarkdownDoc
        owner={owner}
        repo={repo}
        sha={sha}
        path={path}
        contents={state.data.contents}
        onOpenFile={onOpenFile}
      />
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

const DOC_REHYPE_PLUGINS = [rehypeGitHubHeadingIds];

// The rendered-document view for a markdown blob, mirroring the diff
// viewer's rendered docs: GitHub heading slugs for fragment links, relative
// images through the doc-asset proxy, and relative links opened in the pane
// when they name a file in this tree.
function BrowseMarkdownDoc({
  owner,
  repo,
  sha,
  path,
  contents,
  onOpenFile,
}: {
  owner: string;
  repo: string;
  sha: string;
  path: string;
  contents: string;
  onOpenFile(path: string): boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // A /commit/<sha> source pins every asset and link the doc references to
  // the same commit the pane displays.
  const sourcePath = `${owner}/${repo}/commit/${sha}`;
  const components = useMemo<Components>(
    () => ({
      img: ({ node: _node, src, alt, ...rest }) => {
        if (typeof src === 'string') {
          const assetPath = resolveDocAssetPath(src, path);
          if (assetPath != null) {
            return (
              <GitHubAssetImage
                {...rest}
                alt={alt ?? ''}
                src={createDocAssetURL(sourcePath, assetPath, 'new')}
              />
            );
          }
        }
        return <MarkdownImage {...rest} alt={alt} src={src} />;
      },
      a: ({ node: _node, href, ...rest }) => {
        if (typeof href === 'string' && href.startsWith('#')) {
          return (
            <a
              {...rest}
              href={href}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) {
                  return;
                }
                event.preventDefault();
                scrollToDocFragment(containerRef.current, href);
              }}
            />
          );
        }
        const linkTarget =
          typeof href === 'string'
            ? resolveDocLinkTarget(href, path, sourcePath)
            : null;
        if (linkTarget == null) {
          return <a {...rest} href={href} />;
        }
        return (
          <a
            {...rest}
            href={linkTarget.url}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) {
                return;
              }
              // A qualified link back into this document is a section link.
              if (linkTarget.path === path && linkTarget.hash !== '') {
                event.preventDefault();
                scrollToDocFragment(containerRef.current, linkTarget.hash);
                return;
              }
              if (onOpenFile(linkTarget.path)) {
                event.preventDefault();
              }
            }}
          />
        );
      },
    }),
    [onOpenFile, path, sourcePath]
  );
  return (
    <div
      ref={containerRef}
      className="cv-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto w-full max-w-[920px] px-6 py-5">
        <MarkdownContent
          markdown={contents}
          components={components}
          extraRemarkPlugins={DOC_REMARK_PLUGINS}
          rehypePluginsBeforeRaw={DOC_REHYPE_PLUGINS}
        />
      </div>
    </div>
  );
}
