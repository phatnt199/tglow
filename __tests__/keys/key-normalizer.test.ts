import { test, expect } from 'bun:test';

import { KeyNormalizerService } from '../../src/keys/key-normalizer.ts';

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
