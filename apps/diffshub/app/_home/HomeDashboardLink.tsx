'use client';

import { IconArrowRightShort } from '@pierre/icons';
import Link from 'next/link';

import { useGitHubToken } from '@/components/useGitHubToken';

// Renders a link into the /pulls dashboard once a stored GitHub token has
// hydrated. Anonymous visitors (and the server-rendered page) see nothing, so
// the static home markup is untouched.
export function HomeDashboardLink() {
  const { hasToken, hydrated } = useGitHubToken();
  if (!hydrated || !hasToken) {
    return null;
  }
  return (
    <p className="text-sm">
      <Link
        href="/pulls"
        className="inline-link inline-flex items-center gap-1"
      >
        Your pull requests
        <IconArrowRightShort className="size-4" />
      </Link>
    </p>
  );
}
