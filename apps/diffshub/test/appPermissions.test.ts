import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET as commitPreflight } from '../app/api/pull-commit/route';
import { describeMissingAppPermission } from '@/lib/appPermissions';
import {
  loadAppInstallations,
  readInstallations,
} from '@/lib/githubAppInstallations';

const INSTALLATIONS = {
  installations: {
    mimosa: { contents: 'read', pull_requests: 'write', statuses: 'read' },
    acme: { contents: 'write', checks: 'read' },
  },
} as const;

describe('describeMissingAppPermission', () => {
  test("names the installation's missing permission", () => {
    const message = describeMissingAppPermission(
      INSTALLATIONS,
      'Mimosa',
      'commit'
    );
    expect(message).toContain('Contents: Read and write');
    expect(message).toContain('in Mimosa');
    expect(message).toContain('Ask an organization owner');
    expect(
      describeMissingAppPermission(INSTALLATIONS, 'mimosa', 'checkRuns')
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

  // GitHub's "Permissions required for GitHub Apps" (see APP_REQUIREMENTS).
  test('maps each control onto its documented permission', () => {
    // mimosa grants Pull requests write but only Contents read.
    for (const feature of [
      'edit',
      'requestReviews',
      'resolveThread',
      'review',
    ] as const) {
      expect(
        describeMissingAppPermission(INSTALLATIONS, 'mimosa', feature)
      ).toBeNull();
    }
    // Merging and draft toggles need Contents write as well.
    for (const feature of ['merge', 'draft'] as const) {
      expect(
        describeMissingAppPermission(INSTALLATIONS, 'mimosa', feature)
      ).toContain('Contents: Read and write');
    }
    // acme grants Contents write but nothing on pull requests.
    expect(
      describeMissingAppPermission(INSTALLATIONS, 'acme', 'review')
    ).toContain('Pull requests: Read and write');
  });

  // Labels go through the issues endpoints, listed under both permissions.
  test('accepts any one of several listed permissions', () => {
    expect(
      describeMissingAppPermission(INSTALLATIONS, 'mimosa', 'label')
    ).toBeNull();
    expect(
      describeMissingAppPermission(
        { installations: { acme: { issues: 'write' } } },
        'acme',
        'label'
      )
    ).toBeNull();
    expect(
      describeMissingAppPermission(INSTALLATIONS, 'acme', 'label')
    ).toContain('Issues: Read and write or Pull requests: Read and write');
  });

  // Absence proves nothing: GitHub lists only installations the user has
  // explicit access to, and non-App sign-ins aren't limited at all.
  test('restricts nothing without an installation to go on', () => {
    expect(
      describeMissingAppPermission(INSTALLATIONS, 'elsewhere', 'commit')
    ).toBeNull();
    expect(
      describeMissingAppPermission({ installations: null }, 'mimosa', 'commit')
    ).toBeNull();
    expect(describeMissingAppPermission(null, 'mimosa', 'commit')).toBeNull();
  });
});

describe('readInstallations', () => {
  test('keys by lowercased login and skips suspended installations', () => {
    expect(
      readInstallations([
        {
          account: { login: 'Mimosa' },
          permissions: { contents: 'read', bogus: 'sometimes' },
        },
        {
          account: { login: 'paused' },
          permissions: { contents: 'write' },
          suspended_at: '2026-11-17T20:00:00Z',
        },
        { permissions: { contents: 'write' } },
      ])
    ).toEqual({ mimosa: { contents: 'read' } });
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
              account: { login: 'mimosa' },
              permissions: { contents: 'read', pull_requests: 'write' },
            },
          ],
        });
      }
      if (path.endsWith('/repos/mimosa/overlay/pulls/7')) {
        return Response.json({
          state: 'open',
          base: {
            ref: 'main',
            sha: 'base',
            repo: { full_name: 'mimosa/overlay' },
          },
          head: {
            ref: 'topic',
            sha: 'head',
            repo: { full_name: 'mimosa/overlay' },
          },
        });
      }
      return Response.json({ message: 'unexpected' }, { status: 500 });
    });
    const response = await commitPreflight(
      new NextRequest(
        'https://diffshub.test/api/pull-commit?owner=mimosa&repo=overlay&pull=7',
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
      'Contents: Read and write permission in mimosa'
    );
  });

  // A fork pull's commits (edits, conflict merges) land on the fork, so its
  // owner's installation decides, not the base repo's.
  test("the commit preflight checks a fork pull's head owner", async () => {
    fetchSpy = stubGitHub((path) => {
      if (path.endsWith('/user/installations')) {
        return Response.json({
          installations: [
            { account: { login: 'mimosa' }, permissions: { contents: 'read' } },
            {
              account: { login: 'forker' },
              permissions: { contents: 'write' },
            },
          ],
        });
      }
      if (path.endsWith('/repos/mimosa/overlay/pulls/8')) {
        return Response.json({
          state: 'open',
          maintainer_can_modify: false,
          base: {
            ref: 'main',
            sha: 'base',
            repo: { full_name: 'mimosa/overlay' },
          },
          head: {
            ref: 'topic',
            sha: 'head',
            repo: { full_name: 'forker/overlay' },
          },
        });
      }
      if (path.endsWith('/repos/forker/overlay')) {
        return Response.json({ permissions: { push: true } });
      }
      return Response.json({ message: 'unexpected' }, { status: 500 });
    });
    const response = await commitPreflight(
      new NextRequest(
        'https://diffshub.test/api/pull-commit?owner=mimosa&repo=overlay&pull=8',
        { headers: { Authorization: 'Bearer ghu_fork_preflight' } }
      )
    );
    expect(await response.json()).toMatchObject({
      canCommit: true,
      headSha: 'head',
    });
  });
});
