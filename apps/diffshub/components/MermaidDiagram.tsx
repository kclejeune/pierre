'use client';

import { memo, useEffect, useState } from 'react';

// mermaid.render needs a unique element id per invocation.
let nextDiagramId = 0;

type MermaidState =
  | { kind: 'loading' }
  | { kind: 'ready'; svg: string }
  | { kind: 'error' };

// Renders a ```mermaid fenced block as a diagram, matching GitHub's rendered
// markdown. Mermaid is heavy, so it is imported on demand the first time a
// diagram renders; while loading (or when the definition fails to parse) the
// raw definition stays visible as a plain code block.
export const MermaidDiagram = memo(function MermaidDiagram({
  code,
}: {
  code: string;
}) {
  const isDark = useRootIsDark();
  const [state, setState] = useState<MermaidState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDark ? 'dark' : 'default',
        });
        const { svg } = await mermaid.render(
          `diffshub-mermaid-${nextDiagramId++}`,
          code
        );
        if (!cancelled) {
          setState({ kind: 'ready', svg });
        }
      } catch {
        if (!cancelled) {
          setState({ kind: 'error' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, isDark]);

  if (state.kind !== 'ready') {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      className="my-2 flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // Mermaid sanitizes its SVG output under securityLevel: 'strict'.
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
});

// Tracks the app theme through the root element's dark class so diagrams
// re-render with matching colors when the theme flips.
function useRootIsDark(): boolean {
  const [isDark, setIsDark] = useState(
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('dark')
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains('dark'));
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}
