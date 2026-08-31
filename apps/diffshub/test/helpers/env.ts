import { afterEach, beforeEach } from 'bun:test';

import { resetGitHubEnvironmentCache } from '../../lib/githubEnvironment';

// Installs beforeEach/afterEach hooks that snapshot and clear the given
// environment variables and reset the memoized GitHub environment, so
// per-test env mutations cannot leak between tests or files. Call once at
// the top of a describe (or module) whose tests set DIFFSHUB_* variables.
export function useIsolatedEnvironment(keys: readonly string[]): void {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetGitHubEnvironmentCache();
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    resetGitHubEnvironmentCache();
  });
}
