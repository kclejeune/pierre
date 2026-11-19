/** @jsxImportSource react */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { GitHubEnvironmentProvider } from '../components/GitHubEnvironmentProvider';
import { PullRequestRow } from '../components/PullRequestRow';
import { installJsdomGlobals } from '../lib/test/jsdomGlobals';
import type { GitHubClientEnvironment } from '@/lib/githubEnvironment';
import type { PullSummary } from '@/lib/githubPullSummaries';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost',
});

const environment: GitHubClientEnvironment = {
  host: 'github.example.com',
  isGitHubDotCom: false,
  oauthEnabled: false,
  patInputEnabled: true,
  requireLogin: false,
  tokenEncryptionRequired: false,
  webURL: 'https://github.example.com',
};

let restoreGlobals: () => void;

beforeAll(() => {
  restoreGlobals = installJsdomGlobals({
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
});

afterAll(() => {
  restoreGlobals();
  dom.window.close();
});

const pull: PullSummary = {
  authorLogin: 'octocat',
  number: 7,
  owner: 'acme',
  repo: 'widgets',
  state: 'open',
  title: 'Add widgets',
  updatedAt: '2026-01-01T00:00:00Z',
  viewerPath: '/acme/widgets/pull/7',
};

type RowProps = Partial<Parameters<typeof PullRequestRow>[0]>;

// Renders one row and returns its actions trigger. The menu itself is
// Radix's and is exercised in the browser: Radix menus don't open under
// jsdom here.
async function renderRow(props: RowProps) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GitHubEnvironmentProvider environment={environment}>
        <PullRequestRow pull={pull} onOpen={() => {}} {...props} />
      </GitHubEnvironmentProvider>
    );
  });
  return {
    trigger: container.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="menu"]'
    ),
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('PullRequestRow actions', () => {
  test('renders a labeled menu trigger beside the row link', async () => {
    const row = await renderRow({ onRowAction: () => {} });
    try {
      expect(row.trigger?.getAttribute('aria-label')).toBe(
        'Actions for acme/widgets#7'
      );
      // Outside the link, so opening the menu never navigates or previews.
      expect(row.trigger?.closest('a')).toBeNull();
    } finally {
      row.cleanup();
    }
  });

  test('renders no trigger when the list offers no row actions', async () => {
    const row = await renderRow({});
    try {
      expect(row.trigger).toBeNull();
    } finally {
      row.cleanup();
    }
  });
});
