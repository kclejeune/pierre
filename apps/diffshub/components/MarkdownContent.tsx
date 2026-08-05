'use client';

import { IconImage } from '@pierre/icons';
import type { Element as HastElement } from 'hast';
import { memo, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { GitHubAssetImage } from './GitHubAssetImage';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { MermaidDiagram } from './MermaidDiagram';
import { cn } from '@/lib/cn';
import { createGitHubWebAssetProxyURL } from '@/lib/githubWebAssets';

const REMARK_PLUGINS = [remarkGfm];

// GitHub-flavored sanitization, extended to keep the sizing attributes HTML
// <img> tags commonly carry in READMEs (avatar grids, logos, badges). Divs
// additionally keep all data attributes (inert by nature) so caller plugins —
// e.g. the rendered-document view's source-range wrappers — survive
// sanitization without this shared schema naming each caller's attributes.
const SANITIZE_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height', 'align'],
    div: [...(defaultSchema.attributes?.div ?? []), 'data*'],
  },
};

// Raw HTML embedded in the markdown (image tags, <details>, <sup>, …) is
// parsed and then sanitized against the GitHub schema, so it renders the way
// GitHub renders it without opening the page to script injection. Caller
// plugins run BEFORE these (hence the prop name): rehype-raw re-parses the
// whole document, which restructures blocks around malformed HTML and
// invalidates source positions, so any plugin that reads positions must see
// the tree first. Attributes a caller plugin attaches must survive
// SANITIZE_SCHEMA, and the raw re-parse stringifies them.
const BASE_REHYPE_PLUGINS: NonNullable<
  React.ComponentProps<typeof Markdown>['rehypePlugins']
> = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]];

// The default renderer for markdown images: same-instance assets (pasted
// user-attachment images, avatars in HTML tables) are routed through the
// authenticated web-asset proxy so they load on private-mode GHES; every
// other URL renders as a plain <img>. When the instance refuses token auth
// on the asset route, the image cannot be inlined at all from this origin —
// but a top-level navigation carries the viewer's GitHub session, so the
// failure case degrades to a link that opens the image on GitHub. Exported
// so callers overriding `img` for their own URL schemes (the
// rendered-document view's repo-relative paths) can fall back to the same
// behavior.
export function MarkdownImage({
  src,
  alt,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const { webURL } = useGitHubEnvironment();
  const [failed, setFailed] = useState(false);
  const sourceURL = typeof src === 'string' ? src : null;
  const proxied =
    sourceURL != null ? createGitHubWebAssetProxyURL(sourceURL, webURL) : null;
  if (sourceURL == null || proxied == null) {
    return <img {...rest} alt={alt ?? ''} loading="lazy" src={src} />;
  }
  if (failed) {
    return (
      <a
        className="border-border text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 !no-underline"
        href={sourceURL}
        rel="noreferrer noopener"
        target="_blank"
      >
        <IconImage size={14} />
        {alt !== '' && alt != null ? alt : 'Image'} — open on GitHub
      </a>
    );
  }
  return (
    <GitHubAssetImage
      {...rest}
      alt={alt ?? ''}
      src={proxied}
      onError={() => setFailed(true)}
    />
  );
}

// ```mermaid fences render as diagrams (as GitHub does); every other code
// block keeps the default <pre> rendering.
const DEFAULT_COMPONENTS: Components = {
  img: ({ node: _node, ...rest }) => <MarkdownImage {...rest} />,
  pre: ({ node, ...rest }) => {
    const mermaidSource = getMermaidSource(node);
    if (mermaidSource != null) {
      return <MermaidDiagram code={mermaidSource} />;
    }
    return <pre {...rest} />;
  },
};

function getMermaidSource(node: HastElement | undefined): string | null {
  const code = node?.children.find(
    (child): child is HastElement =>
      child.type === 'element' && child.tagName === 'code'
  );
  const className = code?.properties?.className;
  if (!Array.isArray(className) || !className.includes('language-mermaid')) {
    return null;
  }
  const text = code?.children[0];
  return text?.type === 'text' ? text.value : null;
}

// Element styling for rendered markdown, scoped through arbitrary variants so
// no global stylesheet changes are needed. Sized to sit inside annotation
// cards and the rendered-document view.
export const MARKDOWN_PROSE_CLASS = cn(
  'text-[14px] leading-relaxed break-words',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-1 [&_h1]:text-[1.6em] [&_h1]:font-semibold first:[&_h1]:mt-0',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1 [&_h2]:text-[1.35em] [&_h2]:font-semibold first:[&_h2]:mt-0',
  '[&_h3]:mt-3 [&_h3]:mb-2 [&_h3]:text-[1.15em] [&_h3]:font-semibold',
  '[&_h4]:mt-3 [&_h4]:mb-1.5 [&_h4]:font-semibold',
  '[&_h5]:mt-2 [&_h5]:mb-1 [&_h5]:text-[0.95em] [&_h5]:font-semibold',
  '[&_h6]:mt-2 [&_h6]:mb-1 [&_h6]:text-[0.9em] [&_h6]:font-semibold [&_h6]:text-muted-foreground',
  '[&_p]:my-2',
  '[&_a]:text-blue-500 [&_a]:underline [&_a]:underline-offset-2',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-3 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_table]:my-2 [&_table]:block [&_table]:w-max [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse',
  '[&_th]:border [&_th]:border-border [&_th]:px-2.5 [&_th]:py-1 [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1',
  '[&_hr]:my-4 [&_hr]:border-border',
  '[&_img]:max-w-full'
);

interface MarkdownContentProps {
  className?: string;
  components?: Components;
  markdown: string;
  rehypePluginsBeforeRaw?: React.ComponentProps<
    typeof Markdown
  >['rehypePlugins'];
}

// Sanitized-by-default markdown rendering (react-markdown ignores embedded
// raw HTML) with GitHub-flavored extensions. Used for review-comment bodies
// and the rendered-document view.
export const MarkdownContent = memo(function MarkdownContent({
  className,
  components,
  markdown,
  rehypePluginsBeforeRaw,
}: MarkdownContentProps) {
  return (
    <div className={cn(MARKDOWN_PROSE_CLASS, className)}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={[
          ...(rehypePluginsBeforeRaw ?? []),
          ...BASE_REHYPE_PLUGINS,
        ]}
        components={{ ...DEFAULT_COMPONENTS, ...components }}
      >
        {markdown}
      </Markdown>
    </div>
  );
});
