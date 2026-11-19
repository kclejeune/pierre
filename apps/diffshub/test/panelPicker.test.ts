import { describe, expect, test } from 'bun:test';

import { handlePickerSearchKey } from '../components/PanelPicker';

// Presses `key` in a picker searching `filter` whose onEnter reports
// `applied`, returning the filter changes the picker asked for.
function press(key: string, filter: string, applied: boolean): string[] {
  const changes: string[] = [];
  handlePickerSearchKey(
    { key, preventDefault() {}, stopPropagation() {} },
    filter,
    () => applied,
    (next) => changes.push(next)
  );
  return changes;
}

describe('handlePickerSearchKey', () => {
  test('Enter keeps the search when nothing could be picked yet', () => {
    // Results still settling or loading: the search must keep running.
    expect(press('Enter', 'oct', false)).toEqual([]);
    expect(press('Enter', 'oct', true)).toEqual(['']);
    expect(press('a', 'oct', true)).toEqual([]);
  });
});
