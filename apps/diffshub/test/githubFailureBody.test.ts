import { describe, expect, test } from 'bun:test';

import { parseGitHubErrorMessage } from '@/lib/githubCommitServer';
import { describeGitHubFailureBody } from '@/lib/githubProxyResponse';

describe('describeGitHubFailureBody', () => {
  test('appends structured validation errors to the message', () => {
    expect(
      describeGitHubFailureBody({
        message: 'Validation Failed',
        errors: [
          {
            resource: 'PullRequestReviewComment',
            code: 'custom',
            field: 'pull_request_review_thread.line',
            message: 'pull_request_review_thread.line must be part of the diff',
          },
        ],
      })
    ).toBe(
      'Validation Failed (pull_request_review_thread.line must be part of the diff)'
    );
  });

  test('joins string errors, as the reviews endpoint sends them', () => {
    expect(
      describeGitHubFailureBody({
        message: 'Unprocessable Entity',
        errors: ['Line could not be resolved', 'Path could not be resolved'],
      })
    ).toBe(
      'Unprocessable Entity (Line could not be resolved; Path could not be resolved)'
    );
  });

  test('spells out errors that carry no message', () => {
    expect(
      describeGitHubFailureBody({
        message: 'Validation Failed',
        errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }],
      })
    ).toBe('Validation Failed (Issue title missing_field)');
  });

  test('falls back to the bare message, or nothing', () => {
    expect(describeGitHubFailureBody({ message: 'Not Found' })).toBe(
      'Not Found'
    );
    expect(describeGitHubFailureBody({ errors: [] })).toBe('');
    expect(describeGitHubFailureBody('oops')).toBe('');
  });
});

describe('parseGitHubErrorMessage', () => {
  test('includes errors[] detail from JSON bodies', () => {
    expect(
      parseGitHubErrorMessage(
        JSON.stringify({
          message: 'Validation Failed',
          errors: ['Line could not be resolved'],
        })
      )
    ).toBe('Validation Failed (Line could not be resolved)');
  });

  test('keeps non-JSON bodies intact', () => {
    expect(parseGitHubErrorMessage(' <html>bad gateway</html> ')).toBe(
      '<html>bad gateway</html>'
    );
  });
});
