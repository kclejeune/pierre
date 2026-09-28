import { describe, expect, test } from 'bun:test';

import {
  formatSelection,
  isPastedURL,
  linkSelectionTo,
} from '../markdownEditing';
import { splitMentions } from '../remarkMentions';

describe('formatSelection', () => {
  test('wraps the selection and keeps it selected', () => {
    const edit = formatSelection('word', 'bold');
    expect(edit.replacement).toBe('**word**');
    expect(edit.replacement.slice(edit.selectionStart, edit.selectionEnd)).toBe(
      'word'
    );
  });

  test('an empty selection leaves the caret between the markers', () => {
    const edit = formatSelection('', 'code');
    expect(edit).toEqual({
      replacement: '``',
      selectionStart: 1,
      selectionEnd: 1,
    });
  });

  test('links select the url placeholder', () => {
    const edit = formatSelection('docs', 'link');
    expect(edit.replacement).toBe('[docs](url)');
    expect(edit.replacement.slice(edit.selectionStart, edit.selectionEnd)).toBe(
      'url'
    );
  });
});

describe('pasting links', () => {
  test('only single bare http(s) URLs count', () => {
    expect(isPastedURL('https://github.com/a/b/pull/1')).toBe(true);
    expect(isPastedURL('see https://github.com')).toBe(false);
    expect(isPastedURL('javascript:alert(1)')).toBe(false);
  });

  test('wraps the selection with the URL and moves the caret past it', () => {
    const edit = linkSelectionTo('this', 'https://x.dev');
    expect(edit.replacement).toBe('[this](https://x.dev)');
    expect(edit.selectionStart).toBe(edit.replacement.length);
  });
});

describe('splitMentions', () => {
  const webURL = 'https://github.com';

  test('links user and team mentions', () => {
    const nodes = splitMentions('cc @octocat and @acme/core.', webURL);
    expect(nodes?.map((node) => node.url ?? node.value)).toEqual([
      'cc ',
      'https://github.com/octocat',
      ' and ',
      'https://github.com/orgs/acme/teams/core',
      '.',
    ]);
  });

  test('ignores emails and text without mentions', () => {
    expect(splitMentions('mail me@example.com', webURL)).toBeNull();
    expect(splitMentions('no handles here', webURL)).toBeNull();
  });
});
