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

// Zero-padded so no assertion can be satisfied by a substring of a different
// row: "msg1" appears inside "msg150", "msg001" appears inside nothing.
const HISTORY_LENGTH = 200;
const history: IMessageRow[] = Array.from({ length: HISTORY_LENGTH }, (unused, index) => ({
  peerId: 'u1',
  id: index + 1,
  fromId: 'u1',
  date: (index + 1) * 100,
  text: `msg${String(index + 1).padStart(3, '0')}`,
  out: 0,
}));

test('shows sender and text for each message', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={3} focused tokens={tokens} height={10} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('msg1');
  expect(frame).toContain('msg4');
  expect(frame).toContain('Alice');
  expect(frame).toContain('me');
});

// The gutter is the fixed-width field between the marker column and the
// sender. Reading it out is the point: `expect(lines[3]).toContain('4')` was
// satisfied by the text "msg4" further along the same line, so the cursor
// row's absolute number -- the one value that differs from every other row --
// was never actually asserted.
const MARKER_COLUMNS = 1;
const GUTTER_COLUMNS = 4;
const readGutter = (line: string): string =>
  line.slice(MARKER_COLUMNS, MARKER_COLUMNS + GUTTER_COLUMNS).trim();

// Mirrors relativenumber + number, so 3j is obvious before it is typed.
test('the gutter shows relative distance, absolute on the cursor row', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={3} focused tokens={tokens} height={10} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  const lines = renderer.captureCharFrame().split('\n');
  expect(readGutter(lines[0])).toBe('3');
  expect(readGutter(lines[1])).toBe('2');
  expect(readGutter(lines[2])).toBe('1');
  expect(readGutter(lines[3])).toBe('4');
});

test('marks the cursor row when focused', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={1} focused tokens={tokens} height={10} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('▸');
});

test('renders an empty history without crashing', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={[]} cursor={0} focused tokens={tokens} height={10} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('No messages');
});

// Final review, Critical 2: every row was rendered and nothing sliced to the
// pane's height, so with main.ts loading 200 messages into roughly ten rows
// the cursor moved through a list whose first screenful was the only part
// ever on screen. These three pin the window to the cursor at both ends and
// in the middle.
test('the visible window follows the cursor through a long history', async () => {
  const renderer = await renderWithKeys(
    <MessageView
      messages={history}
      cursor={150}
      focused
      tokens={tokens}
      height={10}
      resolveSenderName={resolveSenderName}
    />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  const lines = renderer.captureCharFrame().split('\n');
  expect(lines.find(line => line.includes('msg151'))).toContain('▸');
});

test('the newest message is reachable at the end of a long history', async () => {
  const renderer = await renderWithKeys(
    <MessageView
      messages={history}
      cursor={HISTORY_LENGTH - 1}
      focused
      tokens={tokens}
      height={10}
      resolveSenderName={resolveSenderName}
    />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('msg200');
  expect(frame).not.toContain('msg189');
});

test('the oldest message is on screen when the cursor is at 0', async () => {
  const renderer = await renderWithKeys(
    <MessageView
      messages={history}
      cursor={0}
      focused
      tokens={tokens}
      height={10}
      resolveSenderName={resolveSenderName}
    />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  const lines = renderer.captureCharFrame().split('\n');
  expect(lines.find(line => line.includes('msg001'))).toContain('▸');
  expect(renderer.captureCharFrame()).not.toContain('msg011');
});
