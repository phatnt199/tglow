import { test, expect } from 'bun:test';

import {
  COMMANDS, CommandNames, completeCommand, completions, describeUnknown, parseCommand,
} from '../../tui/command-line.ts';

// ── parsing ───────────────────────────────────────────────────────────────

test('a command is recognised by any of its spellings', () => {
  for (const spelling of ['quit', 'q', 'q!', 'qa']) {
    expect(parseCommand({ input: spelling }).spec?.name).toBe(CommandNames.QUIT);
  }
});

// Typing `:` and pressing Enter is a cancelled command, not a mistyped one.
test('an empty line is no command and no complaint', () => {
  expect(parseCommand({ input: '' }).spec).toBeNull();
  expect(parseCommand({ input: '   ' }).spec).toBeNull();
});

test('a word that is no command resolves to nothing', () => {
  const parsed = parseCommand({ input: 'qq' });
  expect(parsed.spec).toBeNull();
  expect(parsed.lineNumber).toBeNull();
  expect(describeUnknown({ input: 'qq' })).toBe('Not a command: qq');
});

// Whitespace either side of a command is invisible, and treating it as part of
// the word would make a trailing space break `:q `.
test('surrounding whitespace is ignored', () => {
  expect(parseCommand({ input: '  quit  ' }).spec?.name).toBe(CommandNames.QUIT);
});

test('everything after the first word is the argument', () => {
  expect(parseCommand({ input: 'read some thing' }).argument).toBe('some thing');
  expect(parseCommand({ input: 'read' }).argument).toBe('');
});

// vim's own `:{number}`.
test('a bare number is a message to jump to', () => {
  expect(parseCommand({ input: '42' }).lineNumber).toBe(42);
  expect(parseCommand({ input: '1' }).lineNumber).toBe(1);
  expect(parseCommand({ input: 'q' }).lineNumber).toBeNull();
  // Not a bare number, so not a jump -- and not a command either.
  expect(parseCommand({ input: '4x' }).lineNumber).toBeNull();
  expect(parseCommand({ input: '4x' }).spec).toBeNull();
});

// ── completion ────────────────────────────────────────────────────────────

// Canonical spellings only: completing `q` to `q!` would be actively
// unhelpful, and a list showing every alias teaches nothing about what
// commands exist.
test('completion offers canonical spellings, not aliases', () => {
  const offered = completions({ input: 'q' }).map(command => command.spellings[0]);
  expect(offered).toEqual(['quit']);
});

test('an empty line offers everything', () => {
  expect(completions({ input: '' })).toHaveLength(COMMANDS.length);
});

// A line with a space has already chosen its command; completing the word
// again would replace an argument being typed.
test('nothing is completed once an argument has started', () => {
  expect(completions({ input: 'read ' })).toEqual([]);
  expect(completeCommand({ input: 'read ' })).toBe('read ');
});

test('a single match completes in full', () => {
  expect(completeCommand({ input: 'log' })).toBe('logout');
  expect(completeCommand({ input: 'hel' })).toBe('help');
});

// As far as it can without guessing: `p` and `pin`/`unpin` do not share a
// prefix, but `re` does with `read` and `reload`.
test('an ambiguous match advances to the shared prefix and stops', () => {
  expect(completeCommand({ input: 're' })).toBe('re');
  expect(completions({ input: 're' }).map(command => command.spellings[0]).sort())
    .toEqual(['read', 'reload']);
});

test('a word that matches nothing is left alone', () => {
  expect(completeCommand({ input: 'zzz' })).toBe('zzz');
});

// ── the registry itself ───────────────────────────────────────────────────

// The command line teaches itself through the hint beside it, so a command
// with no description is a command nobody will find.
test('every command describes itself and has a spelling', () => {
  for (const command of COMMANDS) {
    expect(command.description.length).toBeGreaterThan(0);
    expect(command.spellings.length).toBeGreaterThan(0);
    expect(command.spellings[0]!.length).toBeGreaterThan(0);
  }
});

// Two commands answering to one word means one of them is unreachable, and
// which one would depend on the order of this array.
test('no spelling belongs to two commands', () => {
  const seen = new Set<string>();
  for (const command of COMMANDS) {
    for (const spelling of command.spellings) {
      expect(seen.has(spelling)).toBe(false);
      seen.add(spelling);
    }
  }
});

// The bar is what cannot be undone by typing the same command again. Logout is
// the only one that clears it: quit reopens, pin unpins, reload reloads.
test('only logout asks first', () => {
  const confirming = COMMANDS.filter(command => command.confirms === true).map(command => command.name);
  expect(confirming).toEqual([CommandNames.LOGOUT]);
});
