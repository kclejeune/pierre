import type { Metadata } from 'next';

import { PullsDashboard } from './PullsDashboard';

export const metadata: Metadata = {
  title: 'Your pull requests · DiffsHub',
  description:
    'Browse your open pull requests, assigned reviews, and pinned repositories.',
};

// The /pulls dashboard. All data is client-fetched with the viewer's stored
// token; this shell stays statically prerenderable like the home page.
export default function PullsPage() {
  return <PullsDashboard />;
}
