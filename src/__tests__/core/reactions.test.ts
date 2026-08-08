import { test, expect } from 'bun:test';

import { CUSTOM_REACTION_PLACEHOLDER, describeReactions } from '../../core/reactions.ts';

test('nobody reacting says nothing at all', () => {
  expect(describeReactions({ reactions: [] })).toBe('');
});

test('reactions read as a tally, in the order Telegram sent them', () => {
  expect(describeReactions({
    reactions: [
      { emoji: '👍', count: 3, chosen: false },
      { emoji: '❤️', count: 1, chosen: false },
    ],
  })).toBe('👍 3  ❤️ 1');
});

// Brackets rather than colour: only one of the two survives a terminal that is
// not showing colour, and this is the one that also survives being copied out.
test('your own reaction is marked', () => {
  expect(describeReactions({ reactions: [{ emoji: '😂', count: 2, chosen: true }] })).toBe('[😂] 2');
});

// A reaction Telegram still lists but nobody holds would otherwise draw a
// tally of zero.
test('a reaction nobody holds is left out', () => {
  expect(describeReactions({
    reactions: [
      { emoji: '👍', count: 0, chosen: false },
      { emoji: '🎉', count: 5, chosen: false },
    ],
  })).toBe('🎉 5');
});

// A custom (Premium) reaction is a sticker this client cannot draw, but its
// count is real -- dropping it would make a message with six of them look like
// a message with none.
test('a custom reaction is stood in for rather than dropped', () => {
  expect(describeReactions({ reactions: [{ emoji: CUSTOM_REACTION_PLACEHOLDER, count: 6, chosen: false }] }))
    .toBe(`${CUSTOM_REACTION_PLACEHOLDER} 6`);
});

// One is still a count: "👍" alone would be ambiguous with a reaction that has
// no tally at all, and the digit is one column.
test('a count of one is still shown', () => {
  expect(describeReactions({ reactions: [{ emoji: '👍', count: 1, chosen: false }] })).toBe('👍 1');
});
