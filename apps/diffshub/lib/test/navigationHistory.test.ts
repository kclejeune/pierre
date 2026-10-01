import { describe, expect, test } from 'bun:test';

import { NavigationHistory } from '../navigationHistory';

describe('NavigationHistory', () => {
  test('back returns to the origin and forward replays the jump', () => {
    const history = new NavigationHistory<string>();
    history.push('a', 'b');
    history.push('b', 'c');
    expect(history.goBack()).toBe('b');
    expect(history.goBack()).toBe('a');
    expect(history.goBack()).toBeNull();
    expect(history.goForward()).toBe('b');
    expect(history.goForward()).toBe('c');
    expect(history.goForward()).toBeNull();
  });

  test('a new jump after going back drops the forward entries', () => {
    const history = new NavigationHistory<string>();
    history.push('a', 'b');
    history.goBack();
    expect(history.canGoForward).toBe(true);
    history.push('a', 'x');
    expect(history.canGoForward).toBe(false);
    expect(history.goBack()).toBe('a');
  });

  test('jumps that land on a list can go back but not forward', () => {
    const history = new NavigationHistory<string>();
    history.push('a', null);
    expect(history.goBack()).toBe('a');
    expect(history.canGoForward).toBe(false);
  });

  test('old entries fall off past the limit', () => {
    const history = new NavigationHistory<number>(2);
    history.push(1, 2);
    history.push(2, 3);
    history.push(3, 4);
    expect(history.goBack()).toBe(3);
    expect(history.goBack()).toBe(2);
    expect(history.goBack()).toBeNull();
  });
});
