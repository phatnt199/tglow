import { test, expect } from 'bun:test';

import { KeyNormalizerService } from '../../src/keys/key-normalizer.ts';

const service = new KeyNormalizerService();

test('plain keys stringify to their name', () => {
  expect(service.toCanonicalString({ key: { name: 'j', ctrl: false, alt: false, shift: false } })).toBe('j');
  expect(service.toCanonicalString({ key: { name: 'escape', ctrl: false, alt: false, shift: false } })).toBe('escape');
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
  expect(service.toCanonicalString({ key: { name: 'escape', ctrl: false, alt: false, shift: true } })).toBe('escape');
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
