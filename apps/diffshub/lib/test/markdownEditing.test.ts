import { describe, expect, test } from 'bun:test';

import {
  editMarkdown,
  formatLines,
  formatSelection,
  headingFormatAt,
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

// Applies a line edit to `value` the way the editor does, for readable asserts.
function applyLines(
  value: string,
  start: number,
  end: number,
  format: Parameters<typeof formatLines>[3]
) {
  const result = formatLines(value, start, end, format);
  const next =
    value.slice(0, result.start) +
    result.edit.replacement +
    value.slice(result.end);
  return {
    next,
    selection: [
      result.start + result.edit.selectionStart,
      result.start + result.edit.selectionEnd,
    ],
  };
}

describe('formatLines', () => {
  test('prefixes the caret line and keeps the caret after the prefix', () => {
    expect(applyLines('one\ntwo', 5, 5, 'quote')).toEqual({
      next: 'one\n> two',
      selection: [7, 7],
    });
  });

  test('numbers each selected non-blank line in an ordered list', () => {
    expect(applyLines('a\n\nb\nc', 0, 6, 'ordered-list').next).toBe(
      '1. a\n\n2. b\n3. c'
    );
  });

  test('toggles the prefix off when every line already has it', () => {
    expect(applyLines('- a\n- b', 0, 7, 'unordered-list').next).toBe('a\nb');
  });

  test('swaps one list style for another instead of stacking prefixes', () => {
    expect(applyLines('- a', 0, 3, 'task-list').next).toBe('- [ ] a');
    expect(applyLines('- [ ] a', 0, 7, 'unordered-list').next).toBe('- a');
  });

  test('a selection ending at a newline leaves the next line alone', () => {
    expect(applyLines('a\nb', 0, 2, 'heading-3').next).toBe('### a\nb');
  });

  test('each heading level adds its own number of #', () => {
    expect(applyLines('a', 0, 0, 'heading-1').next).toBe('# a');
    expect(applyLines('a', 0, 0, 'heading-2').next).toBe('## a');
    expect(applyLines('a', 0, 0, 'heading-3').next).toBe('### a');
  });

  test('a different heading level switches the line instead of stacking', () => {
    expect(applyLines('### a', 0, 0, 'heading-1').next).toBe('# a');
    expect(applyLines('# a', 0, 0, 'heading-2').next).toBe('## a');
  });

  test('the same heading level toggles the heading off', () => {
    expect(applyLines('## a', 0, 0, 'heading-2').next).toBe('a');
  });

  test('switching formats with the caret inside the old prefix lands it after the new one', () => {
    // Without content-relative mapping the caret ended up between the `#`s.
    expect(applyLines('# title', 0, 0, 'heading-2')).toEqual({
      next: '## title',
      selection: [3, 3],
    });
    // Caret inside the task marker `- [ ] `, which the bullet replaces.
    expect(applyLines('- [ ] task', 3, 3, 'unordered-list')).toEqual({
      next: '- task',
      selection: [2, 2],
    });
  });

  test('switching formats keeps the caret at the same spot in the text', () => {
    // Caret between "ti" and "tle".
    expect(applyLines('# title', 4, 4, 'heading-3')).toEqual({
      next: '### title',
      selection: [6, 6],
    });
    expect(applyLines('1. item', 5, 5, 'unordered-list')).toEqual({
      next: '- item',
      selection: [4, 4],
    });
  });

  test('removing a prefix with the caret inside it puts the caret at the text start', () => {
    expect(applyLines('## a', 1, 1, 'heading-2')).toEqual({
      next: 'a',
      selection: [0, 0],
    });
  });

  test('an empty line gets the prefix with the caret after it', () => {
    expect(applyLines('', 0, 0, 'task-list')).toEqual({
      next: '- [ ] ',
      selection: [6, 6],
    });
  });
});

describe('editMarkdown', () => {
  test('a mention after a word gets a separating space', () => {
    expect(editMarkdown('hi', 2, 2, 'mention')).toEqual({
      edit: { replacement: ' @', selectionEnd: 2, selectionStart: 2 },
      end: 2,
      start: 2,
    });
  });

  test('a mention at the start or after whitespace does not', () => {
    expect(editMarkdown('hi ', 3, 3, 'mention').edit.replacement).toBe('@');
    expect(editMarkdown('', 0, 0, 'mention').edit.replacement).toBe('@');
  });

  test('inline formats replace only the selection', () => {
    expect(editMarkdown('a b c', 2, 3, 'code')).toEqual({
      edit: { replacement: '`b`', selectionEnd: 2, selectionStart: 1 },
      end: 3,
      start: 2,
    });
  });
});

describe('headingFormatAt', () => {
  test('reports the exact level of the caret line', () => {
    expect(headingFormatAt('x\n## title\ny', 4)).toBe('heading-2');
    expect(headingFormatAt('# a', 0)).toBe('heading-1');
  });

  test('is null for plain lines and deeper headings', () => {
    expect(headingFormatAt('plain', 2)).toBeNull();
    expect(headingFormatAt('#### deep', 2)).toBeNull();
  });
});
