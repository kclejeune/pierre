import type { AppPermissionLevel, AppPermissions } from './appPermissions';
import { GitHubCommitError } from './githubCommitServer';
import { githubFetch } from './githubFetch';
import { fetchAllGitHubPages } from './githubPagination';
import { createAsyncLRU, credentialCacheScope } from './serverLRU';
import { asRecord } from './untypedJson';

// The DiffsHub GitHub App installations a sign-in can see, with what each
// grants, read with the viewer's own token (GET /user/installations), so no
// app private key is needed. Org owners change installation permissions
// rarely, so a few minutes of staleness is fine.

const INSTALLATIONS_TTL_MS = 5 * 60 * 1000;

const installationsMemory = createAsyncLRU<
  string,
  Record<string, AppPermissions> | null
>({ maxEntries: 1000, ttlMs: INSTALLATIONS_TTL_MS });

const LEVELS: ReadonlySet<string> = new Set(['admin', 'read', 'write']);

// Each active installation's permissions keyed by lowercased org login, or
// null when the token isn't a GitHub App user token: GitHub answers a PAT or
// OAuth App token with 403 (401 for a dead one), and neither is limited by
// an installation.
export function loadAppInstallations(
  token: string
): Promise<Record<string, AppPermissions> | null> {
  return installationsMemory.getOrCreate(
    credentialCacheScope(token),
    async () => {
      let items: unknown[];
      try {
        items = await fetchAllGitHubPages(
          (page) => `/user/installations?per_page=100&page=${page}`,
          (payload) => {
            const list = asRecord(payload)?.installations;
            return Array.isArray(list) ? list : null;
          },
          token,
          githubFetch
        );
      } catch (error) {
        if (
          error instanceof GitHubCommitError &&
          (error.status === 401 || error.status === 403)
        ) {
          return null;
        }
        throw error;
      }
      return readInstallations(items);
    }
  );
}

// Maps installation records onto { login: permissions }, skipping suspended
// installations (they grant nothing, so they read as missing).
export function readInstallations(
  items: readonly unknown[]
): Record<string, AppPermissions> {
  const installations: Record<string, AppPermissions> = {};
  for (const item of items) {
    const record = asRecord(item);
    const login = asRecord(record?.account)?.login;
    if (typeof login !== 'string' || record?.suspended_at != null) {
      continue;
    }
    const permissions: Record<string, AppPermissionLevel> = {};
    for (const [name, level] of Object.entries(
      asRecord(record?.permissions) ?? {}
    )) {
      if (typeof level === 'string' && LEVELS.has(level)) {
        permissions[name] = level as AppPermissionLevel;
      }
    }
    installations[login.toLowerCase()] = permissions;
  }
  return installations;
}
