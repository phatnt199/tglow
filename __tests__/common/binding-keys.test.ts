import { test, expect } from 'bun:test';

import { BindingKeys } from '../../src/common/binding-keys.ts';

test('every binding key uses the @tglow namespace', () => {
  const values = Object.values(BindingKeys) as string[];
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(value).toMatch(/^@tglow\/[a-z-]+\/[a-z-]+$/);
  }
});

test('binding keys are unique', () => {
  const values = Object.values(BindingKeys) as string[];
  expect(new Set(values).size).toBe(values.length);
});
