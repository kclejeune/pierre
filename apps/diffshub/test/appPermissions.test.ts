import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET as commitPreflight } from '../app/api/pull-commit/route';
import {
  hasRememberedRefusal,
  isAppRefusalError,
  readRememberedRefusals,
  rememberAppRefusal,
} from '../components/AppPermissionsContext';
import { describeMissingAppPermission } from '@/lib/appPermissions';
import {
  loadAppInstallations,
  readInstallations,
} from '@/lib/githubAppInstallations';
import { APIRequestError } from '@/lib/pullCommentsClient';

const INSTALLATIONS = {
  installations: {
    octolabs: { contents: 'read', pull_requests: 'write', statuses: 'read' },
    acme: { contents: 'write', checks: 'read' },
  },
} as const;

describe('describeMissingAppPermission', () => {
  test("names the installation's missing permission", () => {
    const message = describeMissingAppPermission(
      INSTALLATIONS,
      'Octolabs',
      'commit'
    );
    expect(message).toContain('Contents: Read and write');
    expect(message).toContain('in Octolabs');
    expect(message).toContain('Ask an organization owner');
    expect(
      describeMissingAppPermission(INSTALLATIONS, 'octolabs', 'checkRuns')
    ).toContain('Checks: Read');
  });

  test('allows what the installation grants, or at a higher level', () => {
    expect(
      describeMissingAppPermission(INSTALLATIONS, 'acme', 'commit')
    ).toBeNull();
    expect(
      describeMissingAppPermission(
        { installations: { acme: { checks: 'write' } } },
        'acme',
        'checkRuns'
      )
    ).toBeNull();
  });

  // Absence proves nothing: GitHub lists only installations the user has
  // explicit access to, and non-App sign-ins aren't limited at all.
  test('restricts nothing without an installation to go on', () => {
    expect(
      describeMissingAppPermission(INSTALLATIONS, 'elsewhere', 'commit')
    ).toBeNull();
    expect(
      describeMissingAppPermission({ installations: null }, 'octolabs', 'commit')
    ).toBeNull();
    expect(describeMissingAppPermission(null, 'octolabs', 'commit')).toBeNull();
  });
});

describe('readInstallations', () => {
  test('keys by lowercased login and skips suspended installations', () => {
    expect(
      readInstallations([
        {
          account: { login: 'Octolabs' },
          permissions: { contents: 'read', bogus: 'sometimes' },
        },
        {
          account: { login: 'paused' },
          permissions: { contents: 'write' },
          suspended_at: '2026-11-17T20:00:00Z',
        },
        { permissions: { contents: 'write' } },
      ])
    ).toEqual({ octolabs: { contents: 'read' } });
  });
});

function stubGitHub(respond: (path: string) => Response): {
  mockRestore(): void;
} {
  return spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Promise.resolve(respond(url.pathname));
  }) as typeof fetch);
}

describe('GitHub App installation lookups', () => {
  let fetchSpy: { mockRestore(): void } | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  // A PAT or OAuth App token can't list installations; nothing limits it.
  test('a token GitHub refuses to list installations for is unrestricted', async () => {
    fetchSpy = stubGitHub(() =>
      Response.json({ message: 'Must use a GitHub App token' }, { status: 403 })
    );
    expect(await loadAppInstallations('ghp_classic_pat')).toBeNull();
  });

  test('the commit preflight refuses without Contents: write', async () => {
    fetchSpy = stubGitHub((path) => {
      if (path.endsWith('/user/installations')) {
        return Response.json({
          installations: [
            {
              account: { login: 'octolabs' },
              permissions: { contents: 'read', pull_requests: 'write' },
            },
          ],
        });
      }
      if (path.endsWith('/repos/octolabs/gadgets/pulls/7')) {
        return Response.json({
          state: 'open',
          base: {
            ref: 'main',
            sha: 'base',
            repo: { full_name: 'octolabs/gadgets' },
          },
          head: {
            ref: 'topic',
            sha: 'head',
            repo: { full_name: 'octolabs/gadgets' },
          },
        });
      }
      return Response.json({ message: 'unexpected' }, { status: 500 });
    });
    const response = await commitPreflight(
      new NextRequest(
        'https://diffshub.test/api/pull-commit?owner=octolabs&repo=gadgets&pull=7',
        { headers: { Authorization: 'Bearer ghu_preflight' } }
      )
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      canCommit: boolean;
      message?: string;
      reason?: string;
    };
    expect(body.canCommit).toBe(false);
    expect(body.reason).toBe('app-permission');
    expect(body.message).toContain(
      'Contents: Read and write permission in octolabs'
    );
  });

  // A fork pull's commits (edits, conflict merges) land on the fork, so its
  // owner's installation decides, not the base repo's.
  test("the commit preflight checks a fork pull's head owner", async () => {
    fetchSpy = stubGitHub((path) => {
      if (path.endsWith('/user/installations')) {
        return Response.json({
          installations: [
            { account: { login: 'octolabs' }, permissions: { contents: 'read' } },
            {
              account: { login: 'forker' },
              permissions: { contents: 'write' },
            },
          ],
        });
      }
      if (path.endsWith('/repos/octolabs/gadgets/pulls/8')) {
        return Response.json({
          state: 'open',
          maintainer_can_modify: false,
          base: {
            ref: 'main',
            sha: 'base',
            repo: { full_name: 'octolabs/gadgets' },
          },
          head: {
            ref: 'topic',
            sha: 'head',
            repo: { full_name: 'forker/gadgets' },
          },
        });
      }
      if (path.endsWith('/repos/forker/gadgets')) {
        return Response.json({ permissions: { push: true } });
      }
      return Response.json({ message: 'unexpected' }, { status: 500 });
    });
    const response = await commitPreflight(
      new NextRequest(
        'https://diffshub.test/api/pull-commit?owner=octolabs&repo=gadgets&pull=8',
        { headers: { Authorization: 'Bearer ghu_fork_preflight' } }
      )
    );
    expect(await response.json()).toMatchObject({
      canCommit: true,
      headSha: 'head',
    });
  });
});

// A refusal belongs to the credential that got it: after signing in again
// (a new token version), the same action is no longer blocked.
describe('remembered refusals', () => {
  test('are scoped to the credential version', () => {
    const refusal = new APIRequestError('denied', 403, 'app-refusal');
    rememberAppRefusal(1, 'Octolabs', 'resolveThread', refusal);
    const refusals = readRememberedRefusals();
    expect(hasRememberedRefusal(refusals, 1, 'octolabs', 'resolveThread')).toBe(
      true
    );
    expect(hasRememberedRefusal(refusals, 2, 'octolabs', 'resolveThread')).toBe(
      false
    );
    expect(hasRememberedRefusal(refusals, 1, 'octolabs', 'draft')).toBe(false);

    // Other failures aren't remembered.
    rememberAppRefusal(1, 'octolabs', 'draft', new Error('Network down'));
    expect(
      hasRememberedRefusal(readRememberedRefusals(), 1, 'octolabs', 'draft')
    ).toBe(false);
  });
});

describe('isAppRefusalError', () => {
  // Keyed on the server's code, never the message text.
  test("recognizes only the server's app-refusal code", () => {
    expect(
      isAppRefusalError(new APIRequestError('denied', 403, 'app-refusal'))
    ).toBe(true);
    expect(
      isAppRefusalError(new APIRequestError('denied', 403, 'forbidden'))
    ).toBe(false);
    expect(
      isAppRefusalError(new Error('Resource not accessible by integration'))
    ).toBe(false);
  });
});
