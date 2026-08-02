import { test, expect } from 'bun:test';

import type { IMessageRow } from '../../../src/core/cache/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../src/tui/theme/index.ts';
import { MessageView } from '../../../src/tui/panes/message-view.tsx';

const tokens = buildTokens({ paletteName: 'sage' });
const resolveSenderName = (opts: { fromId: string | null }): string =>
  opts.fromId === 'me' ? 'me' : 'Alice';

const messages: IMessageRow[] = [1, 2, 3, 4].map(id => ({
  peerId: 'u1', id, fromId: id === 3 ? 'me' : 'u1', date: id * 100, text: `msg${id}`, out: id === 3 ? 1 : 0,
}));

test('shows sender and text for each message', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={3} focused tokens={tokens} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('msg1');
  expect(frame).toContain('msg4');
  expect(frame).toContain('Alice');
  expect(frame).toContain('me');
});

// Mirrors relativenumber + number, so 3j is obvious before it is typed.
test('the gutter shows relative distance, absolute on the cursor row', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={3} focused tokens={tokens} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  const lines = renderer.captureCharFrame().split('\n');
  expect(lines[0]).toContain('3');
  expect(lines[1]).toContain('2');
  expect(lines[2]).toContain('1');
  expect(lines[3]).toContain('4');
});

test('marks the cursor row when focused', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={1} focused tokens={tokens} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('▸');
});

test('renders an empty history without crashing', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={[]} cursor={0} focused tokens={tokens} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('No messages');
});
