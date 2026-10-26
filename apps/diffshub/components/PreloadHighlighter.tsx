'use client';
import { preloadHighlighter } from '@pierre/diffs';
import { useEffect } from 'react';

import { docsThemeCatalog } from '@/components/themeCatalog';
import { getPreferredHighlighter } from '@/lib/getPreferredHighlighter';

export function PreloadHighlighter() {
  useEffect(() => {
    void preloadHighlighter({
      themes: [
        ...new Set([
          'pierre-dark',
          'pierre-dark-soft',
          'pierre-light',
          'pierre-light-soft',
          docsThemeCatalog.defaultDarkThemeName,
          docsThemeCatalog.defaultLightThemeName,
        ]),
      ],
      langs: ['zig', 'rust', 'typescript', 'tsx', 'bash'],
      preferredHighlighter: getPreferredHighlighter(),
    });
  }, []);
  return null;
}
