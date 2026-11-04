import type { Metadata } from 'next';

import { PullsDashboard } from './PullsDashboard';

export const metadata: Metadata = {
  title: 'Pull requests · DiffsHub',
  description:
    'Search pull requests across your repositories or within one, with GitHub search filters and pinned repositories.',
};

// The /pulls dashboard. All data is client-fetched with the viewer's stored
// token; this shell stays statically prerenderable like the home page.
export default function PullsPage() {
  return <PullsDashboard />;
}
