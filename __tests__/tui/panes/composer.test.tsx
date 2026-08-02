import { test, expect } from 'bun:test';

import { VimModes } from '../../../src/keys/common/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../src/tui/theme/index.ts';
import { Composer } from '../../../src/tui/panes/composer.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

test('shows a hint in normal mode when empty', async () => {
  const renderer = await renderWithKeys(
    <Composer text="" mode={VimModes.NORMAL} focused={false} tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('press i to write');
});

test('shows the typed text in insert mode', async () => {
  const renderer = await renderWithKeys(
    <Composer text="on my way" mode={VimModes.INSERT} focused tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('on my way');
});

test('shows a cursor block while in insert mode', async () => {
  const renderer = await renderWithKeys(
    <Composer text="hi" mode={VimModes.INSERT} focused tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('█');
});

test('hides the hint once text has been typed', async () => {
  const renderer = await renderWithKeys(
    <Composer text="hi" mode={VimModes.NORMAL} focused={false} tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).not.toContain('press i to write');
});

test('always shows the prompt marker', async () => {
  const renderer = await renderWithKeys(
    <Composer text="" mode={VimModes.NORMAL} focused={false} tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('❯');
});
