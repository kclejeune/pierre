'use client';

import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/cn';

const REMARK_PLUGINS = [remarkGfm];

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
  rehypePlugins?: React.ComponentProps<typeof Markdown>['rehypePlugins'];
}

// Sanitized-by-default markdown rendering (react-markdown ignores embedded
// raw HTML) with GitHub-flavored extensions. Used for review-comment bodies
// and the rendered-document view.
export const MarkdownContent = memo(function MarkdownContent({
  className,
  components,
  markdown,
  rehypePlugins,
}: MarkdownContentProps) {
  return (
    <div className={cn(MARKDOWN_PROSE_CLASS, className)}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {markdown}
      </Markdown>
    </div>
  );
});
