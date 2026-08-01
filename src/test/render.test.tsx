import { test, expect } from 'bun:test';
import { act, useState } from 'react';

import { useKeyboard } from '@opentui/react';

import { renderWithKeys } from './render.tsx';

const KeyProbe = () => {
  const [seen, setSeen] = useState<string[]>([]);
  useKeyboard(key => setSeen(current => [...current, key.name]));
  return <text>seen:{seen.join(',') || 'none'}</text>;
};

test('keyboard events reach useKeyboard', async () => {
  const renderer = await renderWithKeys(<KeyProbe />, { width: 40, height: 3 });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('seen:none');

  await act(async () => {
    renderer.mockInput.pressKey('j');
  });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('seen:j');

  await act(async () => {
    renderer.mockInput.pressKey('k');
  });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('seen:j,k');
});
