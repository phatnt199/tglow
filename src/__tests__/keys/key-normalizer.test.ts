import { test, expect } from 'bun:test';

import { KeyNormalizerService, parseKeySequence } from '../../keys/key-normalizer.ts';

const service = new KeyNormalizerService();

test('plain keys stringify to their name', () => {
  expect(service.toCanonicalString({ key: { name: 'j', ctrl: false, alt: false, shift: false } })).toBe('j');
});

// "escape" as a bare word would be a string-level prefix of nothing typed by
// coincidence -- except vim-engine's prefix search cannot tell "the letter e"
// from "the start of the word escape", so a named key must always be wrapped.
test('a named key with no modifiers is still wrapped, so it cannot collide with typed text', () => {
  expect(service.toCanonicalString({ key: { name: 'escape', ctrl: false, alt: false, shift: false } })).toBe('<escape>');
  expect(service.toCanonicalString({ key: { name: 'return', ctrl: false, alt: false, shift: false } })).toBe('<return>');
  expect(service.toCanonicalString({ key: { name: 'backspace', ctrl: false, alt: false, shift: false } })).toBe('<backspace>');
});

test('parseKeySequence splits into one token per character outside brackets', () => {
  expect(parseKeySequence('j')).toEqual(['j']);
  expect(parseKeySequence('gg')).toEqual(['g', 'g']);
  expect(parseKeySequence('nf')).toEqual(['n', 'f']);
});

test('parseKeySequence treats a bracketed group as exactly one token', () => {
  expect(parseKeySequence('<escape>')).toEqual(['<escape>']);
  expect(parseKeySequence('<C-p>')).toEqual(['<C-p>']);
  expect(parseKeySequence('<backspace>')).toEqual(['<backspace>']);
});

// The bug the whole tokenization fix exists for: bracket-notating named keys
// alone moved the collision rather than removing it, because a typed "<" is
// itself a bare single-character token that a raw-string startsWith matched
// against every bracketed binding. Tokenizing means a lone "<" parses to
// exactly one token, distinct from any bracketed group.
test('parseKeySequence never merges a bare "<" into a later bracketed token', () => {
  expect(parseKeySequence('<')).toEqual(['<']);
});

// vim itself treats an unbalanced "<" in a mapping as literal text rather
// than erroring, so parseKeySequence degrades the same way instead of
// throwing on a malformed binding string.
test('an unclosed bracket falls back to one literal-character token per character', () => {
  expect(parseKeySequence('<escape')).toEqual(['<', 'e', 's', 'c', 'a', 'p', 'e']);
});

test('modifiers use vim notation', () => {
  expect(service.toCanonicalString({ key: { name: 'p', ctrl: true, alt: false, shift: false } })).toBe('<C-p>');
  expect(service.toCanonicalString({ key: { name: 'j', ctrl: false, alt: true, shift: false } })).toBe('<A-j>');
  expect(service.toCanonicalString({ key: { name: 'u', ctrl: false, alt: false, shift: true } })).toBe('<S-u>');
});

test('modifier order is fixed so a binding matches exactly one key', () => {
  expect(service.toCanonicalString({ key: { name: 'd', ctrl: true, alt: true, shift: false } })).toBe('<C-A-d>');
});

test('shift is not notated on named keys, only single characters', () => {
  expect(service.toCanonicalString({ key: { name: 'escape', ctrl: false, alt: false, shift: true } })).toBe('<escape>');
});

// OpenTUI reports Alt as `option` or `meta`, never `alt`.
test('normalize folds option and meta onto alt', () => {
  const fromOption = service.normalize({ event: { name: 'j', ctrl: false, meta: false, option: true, shift: false } });
  const fromMeta = service.normalize({ event: { name: 'j', ctrl: false, meta: true, option: false, shift: false } });
  const neither = service.normalize({ event: { name: 'j', ctrl: false, meta: false, option: false, shift: false } });
  expect(fromOption.alt).toBe(true);
  expect(fromMeta.alt).toBe(true);
  expect(neither.alt).toBe(false);
});

test('normalize preserves ctrl and shift', () => {
  expect(service.normalize({ event: { name: 'p', ctrl: true, meta: false, option: false, shift: true } })).toEqual({
    name: 'p',
    ctrl: true,
    alt: false,
    shift: true,
  });
});
