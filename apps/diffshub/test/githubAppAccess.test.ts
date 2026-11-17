import { describe, expect, test } from 'bun:test';

import { explainGitHubAppRefusal } from '@/lib/githubAppAccess';
import { GitHubCommitError, updateRef } from '@/lib/githubCommitServer';
import { createGitHubFailureResponse } from '@/lib/githubProxyResponse';

const REFUSAL = 'Resource not accessible by integration';

describe('explainGitHubAppRefusal', () => {
  test('explains integration refusals and keeps GitHub text', () => {
    const explained = explainGitHubAppRefusal(REFUSAL, 'acme/widgets');
    expect(explained).toContain(
      "The DiffsHub GitHub App can't access acme/widgets"
    );
    expect(explained).toContain('Ask an organization owner');
    expect(explained).toEndWith(`(GitHub: ${REFUSAL})`);
    expect(explainGitHubAppRefusal(REFUSAL)).toContain('this repository');
  });

  test('leaves every other failure alone', () => {
    expect(explainGitHubAppRefusal('Not Found')).toBeUndefined();
    expect(
      explainGitHubAppRefusal(
        'Resource not accessible by personal access token'
      )
    ).toBeUndefined();
  });
});

describe('GitHub errors explain integration refusals', () => {
  test('REST failures name the repository', async () => {
    const error = await updateRef(
      { owner: 'acme', repo: 'widgets' },
      'ghu_token',
      'main',
      'sha',
      () =>
        Promise.resolve(Response.json({ message: REFUSAL }, { status: 403 }))
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitHubCommitError);
    expect((error as GitHubCommitError).code).toBe('forbidden');
    expect((error as GitHubCommitError).message).toContain(
      "The DiffsHub GitHub App can't access acme/widgets"
    );

    // Other forbidden errors keep GitHub's text.
    const other = await updateRef(
      { owner: 'acme', repo: 'widgets' },
      'ghu_token',
      'main',
      'sha',
      () =>
        Promise.resolve(
          Response.json({ message: 'Must have admin rights' }, { status: 403 })
        )
    ).catch((thrown: unknown) => thrown);
    expect((other as GitHubCommitError).message).toBe('Must have admin rights');
  });

  test('createGitHubFailureResponse', async () => {
    const response = await createGitHubFailureResponse(
      Response.json({ message: REFUSAL }, { status: 403 })
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain(
      "The DiffsHub GitHub App can't access"
    );

    const other = await createGitHubFailureResponse(
      Response.json({ message: 'Not Found' }, { status: 404 })
    );
    expect(((await other.json()) as { error: string }).error).toBe(
      'GitHub responded with 404: Not Found'
    );
  });
});
