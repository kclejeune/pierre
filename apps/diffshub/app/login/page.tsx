import type { Metadata } from 'next';

import { LoginPage } from './LoginPage';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false },
};

export default function Page() {
  return <LoginPage />;
}
