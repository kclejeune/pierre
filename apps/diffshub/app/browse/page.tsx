import type { Metadata } from 'next';

import { BrowseDashboard } from './BrowseDashboard';

export const metadata: Metadata = {
  title: 'Browse repositories · DiffsHub',
  description:
    'Open a repository file tree at any branch, tag, or commit, or view the diff a ref carries.',
};

// The /browse dashboard. All data is client-fetched with the viewer's stored
// token; this shell stays statically prerenderable like the home page.
export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string | string[] }>;
}) {
  const { repo } = await searchParams;
  return (
    <BrowseDashboard
      initialRepo={typeof repo === 'string' ? repo : undefined}
    />
  );
}
