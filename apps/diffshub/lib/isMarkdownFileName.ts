const MARKDOWN_EXTENSIONS = /\.(md|markdown|mdx|mdc)$/i;

// Whether a diff file should offer the rendered-markdown document view.
export function isMarkdownFileName(name: string): boolean {
  return MARKDOWN_EXTENSIONS.test(name);
}
