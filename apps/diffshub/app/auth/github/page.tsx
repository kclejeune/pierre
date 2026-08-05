import type { Metadata } from 'next';

import { GitHubAuthCompletePage } from './GitHubAuthCompletePage';

export const metadata: Metadata = {
  title: 'GitHub sign-in',
  robots: { index: false },
};

export default function Page() {
  return <GitHubAuthCompletePage />;
}
