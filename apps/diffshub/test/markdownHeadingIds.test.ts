import { describe, expect, test } from 'bun:test';
import type { Element, Root } from 'hast';

import { rehypeGitHubHeadingIds } from '../lib/markdownHeadingIds';

function heading(
  tagName: string,
  text: string,
  properties: Element['properties'] = {}
): Element {
  return {
    type: 'element',
    tagName,
    properties,
    children: [{ type: 'text', value: text }],
  };
}

function wrap(child: Element): Element {
  return { type: 'element', tagName: 'div', properties: {}, children: [child] };
}

function run(children: Root['children']): Root {
  const tree: Root = { type: 'root', children };
  rehypeGitHubHeadingIds()(tree);
  return tree;
}

function idOf(node: Root['children'][number]): unknown {
  return node.type === 'element' ? node.properties.id : undefined;
}

describe('rehypeGitHubHeadingIds', () => {
  test('slugs heading text with GitHub rules', () => {
    const tree = run([
      heading('h1', 'Getting Started'),
      heading('h2', "What's new in v2.0?"),
    ]);
    expect(idOf(tree.children[0])).toBe('getting-started');
    expect(idOf(tree.children[1])).toBe('whats-new-in-v20');
  });

  test('suffixes repeated headings the way GitHub does', () => {
    const tree = run([
      heading('h2', 'Usage'),
      heading('h2', 'Usage'),
      heading('h2', 'Usage'),
    ]);
    expect(idOf(tree.children[0])).toBe('usage');
    expect(idOf(tree.children[1])).toBe('usage-1');
    expect(idOf(tree.children[2])).toBe('usage-2');
  });

  test('reaches headings nested in wrappers and keeps existing ids', () => {
    const wrapped = wrap(heading('h3', 'Nested Section'));
    const tree = run([wrapped, heading('h2', 'Own Anchor', { id: 'custom' })]);
    const nested = (tree.children[0] as Element).children[0];
    expect(idOf(nested)).toBe('nested-section');
    expect(idOf(tree.children[1])).toBe('custom');
  });

  test('leaves non-heading elements alone', () => {
    const tree = run([heading('p', 'Not a heading')]);
    expect(idOf(tree.children[0])).toBeUndefined();
  });
});
