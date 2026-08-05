import { getFiletypeFromFileName } from '@pierre/diffs';

const MARKDOWN_FILETYPES = new Set(['markdown', 'mdx', 'mdc']);

// Whether a diff file should offer the rendered-markdown document view. Keyed
// off the library's filetype resolution so the toggle appears exactly for the
// files the viewer already treats as markdown (including custom-registered
// extensions).
export function isMarkdownFileName(name: string): boolean {
  return MARKDOWN_FILETYPES.has(getFiletypeFromFileName(name));
}
