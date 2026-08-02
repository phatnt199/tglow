import { test, expect } from 'bun:test';

import type { IDialogRow } from '../../../src/core/cache/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../src/tui/theme/index.ts';
import { ChatList } from '../../../src/tui/panes/chat-list.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

const dialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 9 },
  { peerId: 'u2', title: 'Bob', pinned: 0, unreadCount: 0, lastMessageAt: 200, topMessageId: 4 },
  { peerId: 'c1', title: 'devs', pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 2 },
];

test('lists every chat', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={0} focused tokens={tokens} width={20} height={10} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('Alice');
  expect(frame).toContain('Bob');
  expect(frame).toContain('devs');
});

test('shows unread counts', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={0} focused tokens={tokens} width={20} height={10} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('2');
  expect(frame).toContain('7');
});

test('marks the cursor row when focused', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={1} focused tokens={tokens} width={20} height={10} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('▸ Bob');
});

test('does not mark the cursor row when unfocused', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={1} focused={false} tokens={tokens} width={20} height={10} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).not.toContain('▸');
});

// Final review, Critical 2: the pane rendered every dialog regardless of the
// rows it had, so a chat list longer than the sidebar could not be scrolled
// to -- the cursor moved onto rows that were never drawn.
test('the visible window follows the cursor through a long chat list', async () => {
  const many: IDialogRow[] = Array.from({ length: 40 }, (unused, index) => ({
    peerId: `p${index}`,
    title: `chat${String(index).padStart(2, '0')}`,
    pinned: 0,
    unreadCount: 0,
    lastMessageAt: index,
    topMessageId: index,
  }));
  const renderer = await renderWithKeys(
    <ChatList dialogs={many} cursor={39} focused tokens={tokens} width={20} height={6} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('chat39');
  expect(frame).not.toContain('chat00');
});

test('renders an empty list without crashing', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={[]} cursor={0} focused tokens={tokens} width={20} height={10} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('No chats');
});
