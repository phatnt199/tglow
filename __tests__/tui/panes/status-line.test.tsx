import { test, expect } from 'bun:test';

import { VimModes } from '../../../src/keys/common/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../src/tui/theme/index.ts';
import { StatusLine } from '../../../src/tui/panes/status-line.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

test('shows mode, chat, unread count and position', async () => {
  const renderer = await renderWithKeys(
    <StatusLine mode={VimModes.NORMAL} title="Alice" unreadCount={3} position={4} total={312}
                hint="\\ for keys" tokens={tokens} />,
    { width: 60, height: 1 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('NORMAL');
  expect(frame).toContain('Alice');
  expect(frame).toContain('3 unread');
  expect(frame).toContain('4/312');
});

test('the mode label is upper case, like lualine', async () => {
  const renderer = await renderWithKeys(
    <StatusLine mode={VimModes.INSERT} title="Bob" unreadCount={0} position={1} total={1} hint="" tokens={tokens} />,
    { width: 60, height: 1 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('INSERT');
});

test('a zero unread count is not shown', async () => {
  const renderer = await renderWithKeys(
    <StatusLine mode={VimModes.NORMAL} title="Bob" unreadCount={0} position={1} total={1} hint="" tokens={tokens} />,
    { width: 60, height: 1 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).not.toContain('unread');
});
