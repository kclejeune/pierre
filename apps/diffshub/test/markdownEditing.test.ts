import { describe, expect, test } from 'bun:test';

import {
  editMarkdown,
  formatLines,
  formatSelection,
  headingFormatAt,
} from '../lib/markdownEditing';

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

  test('an empty line gets the prefix with the caret after it', () => {
    expect(applyLines('', 0, 0, 'task-list')).toEqual({
      next: '- [ ] ',
      selection: [6, 6],
    });
  });
});

describe('formatSelection', () => {
  test('bold wraps and keeps the text selected', () => {
    expect(formatSelection('x', 'bold')).toEqual({
      replacement: '**x**',
      selectionEnd: 3,
      selectionStart: 2,
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
