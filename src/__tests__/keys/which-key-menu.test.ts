import { test, expect } from 'bun:test';

import { resolveWhichKeyMenu } from '../../keys/which-key-menu.ts';

const bindings = [
  { keys: 'j', description: 'Next message' },
  { keys: 'gg', description: 'Oldest loaded' },
  { keys: 'gf', description: 'Focus chat list' },
  { keys: '<C-w>h', description: 'Focus the pane left' },
  { keys: '<C-w>\\', description: 'Split into a column' },
  { keys: '<C-w>c', description: 'Close pane' },
  { keys: '<escape>', description: 'Leave' },
];

test('with nothing pending, everything is offered', () => {
  const menu = resolveWhichKeyMenu({ bindings, pending: [] });

  expect(menu.prefix).toBe('');
  expect(menu.entries).toHaveLength(bindings.length);
});

// The whole point: after <C-w>, the only useful thing to show is what
// completes <C-w>.
test('a pending prefix leaves only what continues it', () => {
  const menu = resolveWhichKeyMenu({ bindings, pending: ['<C-w>'] });

  expect(menu.prefix).toBe('<C-w>');
  expect(menu.entries.map(entry => entry.keys).sort()).toEqual(['\\', 'c', 'h']);
});

// And what is shown is what is left to press, not the whole binding -- the
// prefix is already in the heading and reading it twice is noise.
test('the part already typed is stripped from what is shown', () => {
  const menu = resolveWhichKeyMenu({ bindings, pending: ['g'] });

  expect(menu.entries.map(entry => entry.keys).sort()).toEqual(['f', 'g']);
  expect(menu.entries.every(entry => !entry.keys.startsWith('g') || entry.keys === 'g')).toBe(true);
});

test('descriptions travel with their keys', () => {
  const menu = resolveWhichKeyMenu({ bindings, pending: ['<C-w>'] });

  expect(menu.entries.find(entry => entry.keys === 'c')?.description).toBe('Close pane');
});

// A binding equal to the prefix has nothing left to press, so offering it
// would show a key that completes nothing.
test('a binding that is exactly the prefix is not offered', () => {
  const menu = resolveWhichKeyMenu({
    bindings: [{ keys: 'g', description: 'Something' }, { keys: 'gg', description: 'Oldest' }],
    pending: ['g'],
  });

  expect(menu.entries.map(entry => entry.keys)).toEqual(['g']);
});

// Compared token by token, never as strings: `<escape>` is one token however
// many characters it takes to write, and a typed `<` is a different token that
// string comparison would call a prefix of it.
test('a bracketed key is one token, not a string prefix', () => {
  const menu = resolveWhichKeyMenu({
    bindings: [{ keys: '<escape>', description: 'Leave' }, { keys: '<C-w>h', description: 'Left' }],
    pending: ['<'],
  });

  expect(menu.entries).toEqual([]);
});

test('a prefix nothing continues offers nothing rather than everything', () => {
  expect(resolveWhichKeyMenu({ bindings, pending: ['q'] }).entries).toEqual([]);
});

test('a two-key prefix narrows again', () => {
  const menu = resolveWhichKeyMenu({
    bindings: [
      { keys: 'zab', description: 'Deep' },
      { keys: 'zac', description: 'Deeper' },
      { keys: 'zb', description: 'Elsewhere' },
    ],
    pending: ['z', 'a'],
  });

  expect(menu.entries.map(entry => entry.keys).sort()).toEqual(['b', 'c']);
});
