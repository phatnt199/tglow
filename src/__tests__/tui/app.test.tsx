import { test, expect } from 'bun:test';
import { act } from 'react';

import { createMockMouse, MouseButtons } from '@opentui/core/testing';

import { BindingScopes, Container } from '@venizia/ignis-inversion';
import { rgbToHex } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import { BindingKeys } from '../../common/index.ts';
// Concrete module, not the core/ barrel -- see src/tui/action-reducer.ts for why.
import { ApplicationStoreService } from '../../core/application-store.ts';
import { DatabaseService, type IDialogRow, type IMessageRow } from '../../core/cache/index.ts';
// Concrete module, not the core/ barrel -- same reasoning as
// ApplicationStoreService above (src/tui/action-reducer.ts explains why):
// a value import (mount() below constructs one), off the root barrel's
// telegram/global.window crash path. core/cache/index.ts, used for
// DatabaseService just above, is its own safe sub-barrel -- it re-exports
// only database.ts/migrate.ts/schema.ts, none of which touch telegram or
// global.window, which is why it was already fine to use directly there.
import { MessageSearchService } from '../../core/message-search.ts';
import { ActionTypes, VimContexts, VimModes, type IKeyBinding } from '../../keys/common/index.ts';
import { KeyNormalizerService, KeymapService, VimEngineService } from '../../keys/index.ts';
import { renderWithKeys } from '../helpers/render.tsx';
import { buildTokens } from '../../tui/theme/index.ts';
import { App } from '../../tui/app.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

// Mirrors the layout constants in src/tui/app.tsx.
const TERMINAL_WIDTH = 70;
const TERMINAL_HEIGHT = 14;
const SIDEBAR_WIDTH = 22;
const CHROME_HEIGHT = 2;

// Wide enough that the which-key popup's own column-major layout
// (resolveWhichKeyHeight, which-key.tsx) never has to clip a row off the
// bottom of the frame -- at TERMINAL_WIDTH/TERMINAL_HEIGHT above, a popup
// listing every NORMAL/messages binding overflows long before reaching the
// engine-intrinsic entries appended last (keymap.ts's own describe()), which
// is exactly the gap a captureCharFrame assertion on those entries would
// otherwise miss for reasons that have nothing to do with what it is testing.
// 100x24 is also exactly what task-discoverability-report.md captures.
const WIDE_TERMINAL_WIDTH = 100;
const WIDE_TERMINAL_HEIGHT = 24;

const dialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 3, readOutboxMaxId: 0, preview: null },
];
const messages: IMessageRow[] = [1, 2, 3, 4].map(id => ({
  peerId: 'u1', id, fromId: 'u1', date: id * 100, text: `msg${id}`, out: 0, entities: [], replyToMessageId: null,
}));

// What main.ts actually loads. Zero-padded so no assertion can be satisfied by
// a substring of another row -- "msg1" is inside "msg150", "msg001" is not.
const history: IMessageRow[] = Array.from({ length: 200 }, (unused, index) => ({
  peerId: 'u1',
  id: index + 1,
  fromId: 'u1',
  date: (index + 1) * 100,
  text: `msg${String(index + 1).padStart(3, '0')}`,
  out: 0,
  entities: [],
  replyToMessageId: null,
}));

// A lone \x1b could still open a CSI sequence, so OpenTUI's input parser holds
// it for 20ms before giving up and delivering a bare Escape. Every other key
// arrives synchronously; this one needs the window to pass first, or the press
// simply never reaches the handler and the test proves nothing.
const ESCAPE_FLUSH_MILLISECONDS = 60;

// Long enough that a synchronous onSend could never stand in for it: the bug
// this guards against only exists in the gap between dispatch and resolution,
// so the stub has to actually hold that gap open.
const SEND_ROUND_TRIP_MILLISECONDS = 20;
// Comfortably past the fake round-trip above, so an assertion taken after this
// wait sees the state onSend's `.finally()` leaves behind, not a mid-flight one.
const SEND_SETTLE_MILLISECONDS = SEND_ROUND_TRIP_MILLISECONDS + 10;

// CHAT_OPEN chains onMarkRead onto onOpenChat's own promise (read the
// just-loaded messages, then mark the newest one read), which is one more
// microtask hop than a bare await captures reliably -- this real wait is what
// lets that chain actually settle before an assertion reads `marked`.
const MARK_READ_SETTLE_MILLISECONDS = 20;

// Mirrors IApplicationConfiguration's own default (src/core/configuration.ts) -- vim's timeoutlen.
const TIMEOUT_MILLISECONDS = 400;
// Comfortably past TIMEOUT_MILLISECONDS, the same margin SEND_SETTLE_MILLISECONDS
// gives SEND_ROUND_TRIP_MILLISECONDS above -- long enough that a bare `n`'s own
// ambiguity against `nf` (M1b-2 Task 9) has genuinely timed out by the time an
// assertion runs, not merely "probably has by now".
const AMBIGUOUS_KEY_SETTLE_MILLISECONDS = TIMEOUT_MILLISECONDS + 100;

const pressEscape = async (renderer: TestRendererSetup): Promise<void> => {
  await act(async () => {
    renderer.mockInput.pressEscape();
    await new Promise(resolve => { setTimeout(resolve, ESCAPE_FLUSH_MILLISECONDS); });
  });
  await renderer.flush();
};

const mount = async (opts: {
  dialogs?: IDialogRow[];
  messages?: IMessageRow[];
  onSend?: (text: string) => Promise<void>;
  onEdit?: (edit: { messageId: number; text: string }) => Promise<void>;
  onDelete?: (deletion: { messageIds: number[] }) => Promise<void>;
  onOpenChat?: (chat: { peerId: string }) => Promise<void>;
  /**
   * Appended to the real 28-binding keymap rather than replacing it, so
   * everything else these tests rely on (dd's own confirmation included)
   * keeps working unchanged. Task 2's timeout tests are the only callers:
   * the real keymap's own ambiguous sequence (bare `d` against `dd`, Task 3)
   * resolves its short half to operator-pending state with no action of its
   * own to observe, so these tests still need a synthetic short binding
   * whose resolution -- unlike operator-pending's -- is something an
   * assertion can see.
   */
  extraBindings?: IKeyBinding[];
  /**
   * Defaults to TERMINAL_WIDTH/TERMINAL_HEIGHT, like every existing caller
   * expects. The which-key discoverability test below is the only caller
   * that needs more room -- see WIDE_TERMINAL_WIDTH/HEIGHT's own comment.
   */
  width?: number;
  height?: number;
} = {}) => {
  const container = new Container({ scope: 'AppTest' });
  container.bind({ key: BindingKeys.KEY_NORMALIZER }).toClass(KeyNormalizerService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.VIM_ENGINE }).toClass(VimEngineService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.KEYMAP }).toClass(KeymapService).setScope(BindingScopes.SINGLETON);

  const keymapService = container.get<KeymapService>({ key: BindingKeys.KEYMAP });
  if (opts.extraBindings) {
    // getBindings is a plain, mutable instance property (not readonly), so
    // reassigning it is type-safe with no cast and no subclass -- and scoped
    // to this one container/test, since every mount() builds its own.
    const extendedBindings = [...keymapService.getBindings(), ...opts.extraBindings];
    keymapService.getBindings = () => extendedBindings;
  }

  const seedDialogs = opts.dialogs ?? dialogs;
  const seedMessages = opts.messages ?? messages;

  const store = new ApplicationStoreService();
  store.setState({
    patch: {
      dialogs: seedDialogs,
      messages: seedMessages,
      activePeerId: 'u1',
      connection: 'connected',
    },
  });

  // M1b-2 Task 9: `/` search reads the real cache, not state.messages --
  // seeded here with exactly what the store above was, so the two can never
  // silently disagree about what a chat's messages are, the same invariant
  // production keeps by populating state.messages *from* this same database
  // in the first place (MessageService.loadHistory). Peers for every dialog
  // (not only 'u1'), deduplicated, since a message's peerId is a foreign key
  // the schema enforces -- inserting a message for a peer with no row would
  // otherwise throw.
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  const seededPeerIds = new Set<string>();
  for (const dialog of seedDialogs) {
    if (seededPeerIds.has(dialog.peerId)) {
      continue;
    }
    seededPeerIds.add(dialog.peerId);
    database.upsertPeer({ id: dialog.peerId, type: 'user', accessHash: null, title: dialog.title, username: null });
  }
  database.insertMessages({ messages: seedMessages });
  const messageSearchService = new MessageSearchService(database);

  const sent: string[] = [];
  // What the composer held at the moment the send handler ran. MessageService
  // decides whether to clear by comparing exactly this against the text it
  // sent, so an empty string here means that comparison can never be true --
  // which is what App clearing optimistically did to it.
  const composerAtSend: string[] = [];
  const opened: string[] = [];
  const quit: boolean[] = [];

  // Stands in for MessageService, which owns the composer: it clears on
  // success only if what it sent is still what is there, and deliberately
  // preserves it on failure.
  const onSend = opts.onSend ?? (async (text: string): Promise<void> => {
    sent.push(text);
    // MessageService takes its snapshot after the network round-trip, so this
    // one has to come after a turn of the loop as well. Read synchronously it
    // would see the state from before App's own patch landed, and a composer
    // App had cleared would still look untouched.
    await Promise.resolve();
    composerAtSend.push(store.getState().composerText);
    if (store.getState().composerText === text) {
      store.setState({ patch: { composerText: '' } });
    }
  });

  // Stands in for MessageService.edit, the same way onSend above stands in for
  // MessageService.send: clears composerText and editingMessageId together,
  // and only if the composer still holds exactly what was sent for editing.
  const edited: Array<{ messageId: number; text: string }> = [];
  const onEdit = opts.onEdit ?? (async (edit: { messageId: number; text: string }): Promise<void> => {
    edited.push(edit);
    await Promise.resolve();
    if (store.getState().composerText === edit.text) {
      store.setState({ patch: { composerText: '', editingMessageId: null } });
    }
  });

  // Stands in for MessageService.delete. Unlike onSend/onEdit there is no
  // composer text to protect, so nothing here needs the "still what I sent?"
  // guard -- App itself clears pendingConfirmation the instant y is pressed
  // (action-reducer.ts's CONFIRM case), before this ever runs.
  const deleted: Array<{ messageIds: number[] }> = [];
  const onDelete = opts.onDelete ?? (async (deletion: { messageIds: number[] }): Promise<void> => {
    deleted.push(deletion);
  });

  const onOpenChat = opts.onOpenChat ?? (async (chat: { peerId: string }): Promise<void> => {
    opened.push(chat.peerId);
  });

  // Stands in for MessageService.markRead. Unlike onSend/onEdit/onDelete this
  // fake never mutates the store -- App itself decides, from state already
  // there, when a chat has been opened or the cursor has reached the newest
  // message; markRead is purely a courtesy call outward, so nothing here
  // needs to be read back.
  const marked: Array<{ peerId: string; maxId: number }> = [];
  const onMarkRead = async (read: { peerId: string; maxId: number }): Promise<void> => {
    marked.push(read);
  };

  const renderer = await renderWithKeys(
    <App
      store={store}
      engine={container.get<VimEngineService>({ key: BindingKeys.VIM_ENGINE })}
      keymapService={keymapService}
      keyNormalizer={container.get<KeyNormalizerService>({ key: BindingKeys.KEY_NORMALIZER })}
      timeoutMilliseconds={TIMEOUT_MILLISECONDS}
      tokens={tokens}
      resolveSenderName={() => 'Alice'}
      messageSearchService={messageSearchService}
      onSend={onSend}
      onEdit={onEdit}
      onDelete={onDelete}
      onQuit={() => { quit.push(true); }}
      onOpenChat={onOpenChat}
      onMarkRead={onMarkRead}
    />,
    { width: opts.width ?? TERMINAL_WIDTH, height: opts.height ?? TERMINAL_HEIGHT },
  );
  await renderer.flush();
  return { renderer, store, sent, composerAtSend, edited, deleted, opened, marked, quit, database };
};

test('starts in NORMAL mode with both panes on screen', async () => {
  const { renderer } = await mount();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('NORMAL');
  expect(frame).toContain('Alice');
  expect(frame).toContain('msg1');
  // The leader is one backslash. A JSX attribute performs no escaping, so
  // hint="\\ for keys" put both on the status line.
  expect(frame).not.toContain('\\\\');
});

// The `▸` these assertions used to look for is gone: the owner's neovim marks
// position with cursorlineopt="both", so the cursor is a background across the
// row. Reading the highlighted rows out by colour keeps the assertion on the
// same fact -- which row the cursor is on -- through the change of mechanism,
// and additionally pins that exactly one row carries it.
const cursorRows = (renderer: TestRendererSetup): number[] =>
  renderer.captureSpans().lines.flatMap((line, index) =>
    line.spans.some(span => rgbToHex(span.bg).toLowerCase() === tokens.messageCursor.toLowerCase())
      ? [index]
      : []);

const rowContaining = (renderer: TestRendererSetup, text: string): number =>
  renderer.captureCharFrame().split('\n').findIndex(line => line.includes(text));

test('j moves the cursor — engine to store to render', async () => {
  const { renderer, store } = await mount();
  expect(store.getState().messageCursor).toBe(0);
  expect(cursorRows(renderer)).toEqual([rowContaining(renderer, 'msg1')]);

  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();

  expect(store.getState().messageCursor).toBe(1);
  expect(cursorRows(renderer)).toEqual([rowContaining(renderer, 'msg2')]);
});

// M1a drew a bare rule and no boxes, because boxing each pane separately put a
// doubled `┐┌` where two of them met. M2 boxes them at the owner's choice, but
// as ONE frame: the panes meet at a junction this application draws itself, so
// the seam that motivated the old rule cannot come back.
test('the panes sit inside one frame, meeting at a junction rather than a seam', async () => {
  const { renderer } = await mount();
  const rows = renderer.captureCharFrame().split('\n');

  const top = rows[0]!;
  expect(top.startsWith('┌')).toBe(true);
  expect(top.endsWith('┐')).toBe(true);
  expect(top).toContain('┬');
  // Exactly one junction, and never the doubled corner of two adjacent boxes.
  expect(top.split('┬')).toHaveLength(2);
  expect(rows.join('\n')).not.toContain('┐┌');
  expect(rows.join('\n')).not.toContain('┘└');
});

// Every row of the frame has to be the same width, or the panes stop lining up
// with the edges above and below them and start drawing over their own border.
test('the frame junction sits in the same column on every row it spans', async () => {
  const { renderer } = await mount();
  const rows = renderer.captureCharFrame().split('\n');
  const junction = rows[0]!.indexOf('┬');
  expect(junction).toBeGreaterThan(0);

  // The body rows between the two edges carry the vertical at that column.
  const bottomIndex = rows.findIndex(row => row.startsWith('└'));
  expect(bottomIndex).toBeGreaterThan(1);
  for (const row of rows.slice(1, bottomIndex)) {
    expect({ row, at: row[junction] }).toEqual({ row, at: '│' });
  }
  expect(rows[bottomIndex]![junction]).toBe('┴');
});

test('the pane titles name the chat list and the open chat', async () => {
  const { renderer } = await mount();
  const top = renderer.captureCharFrame().split('\n')[0]!;
  expect(top).toContain('Chats');
  expect(top).toContain('Alice');
});

test('the open chat is marked in the sidebar independently of the cursor', async () => {
  const { renderer } = await mount();
  // Row 0 is the frame's top edge now, and the first column is its border, so
  // the marker sits one row down and one column in.
  expect(renderer.captureCharFrame().split('\n')[1]![1]).toBe('▎');
});

test('3j moves three messages', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('3');
    renderer.mockInput.pressKey('j');
  });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(3);
});

// Task 5, end to end: z is otherwise unbound so the engine holds it as a
// pending prefix exactly as it does for gg/nf, the reducer adds the message
// id to revealedSpoilers as a brand-new Set, and MessageView actually
// re-renders because useSyncExternalStore sees the reference change.
test('zs reveals the spoiler under the cursor', async () => {
  const spoilerMessages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'the answer is 42', entities: [{ kind: 'spoiler', offset: 14, length: 2 }],
  }];
  const { renderer, store } = await mount({ messages: spoilerMessages });
  expect(renderer.captureCharFrame()).toContain('█');
  expect(renderer.captureCharFrame()).not.toContain('42');

  await act(async () => {
    renderer.mockInput.pressKey('z');
    renderer.mockInput.pressKey('s');
  });
  await renderer.flush();

  expect(store.getState().revealedSpoilers.has(1)).toBe(true);
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('42');
  expect(frame).not.toContain('█');
});

// Gap 4b (task-11-report.md): "the URL shown on K" (spec §3.1), and M1a's own
// lesson that a guarantee tested only at the reducer layer can be defeated
// one layer up -- this exercises the real key press, not applyAction directly.
test('<S-k> shows the url of the link under the cursor on the status line', async () => {
  const linkMessages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'see docs', entities: [{ kind: 'textUrl', offset: 4, length: 4, url: 'https://example.com' }],
  }];
  const { renderer, store } = await mount({ messages: linkMessages });
  await act(async () => { renderer.mockInput.pressKey('k', { shift: true }); });
  await renderer.flush();
  expect(store.getState().statusMessage).toBe('https://example.com');
  expect(renderer.captureCharFrame()).toContain('https://example.com');
});

// A key that appears to do nothing reads as broken -- <S-k> on a message with
// no link must say so, not sit silent the way a missing binding would.
test('<S-k> says so, rather than doing nothing, when the message under the cursor has no link', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('k', { shift: true }); });
  await renderer.flush();
  expect(store.getState().statusMessage).toBeTruthy();
  expect(store.getState().statusMessage).not.toContain('http');
});

test('r starts a reply and the composer shows the quoted message', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('r'); });
  await renderer.flush();
  expect(store.getState().replyToMessageId).toBe(store.getState().messages[store.getState().messageCursor]!.id);
  expect(renderer.captureCharFrame()).toContain('Replying');
});

test('escape cancels a reply without leaving normal mode', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('r'); });
  await renderer.flush();
  await pressEscape(renderer);
  expect(store.getState().replyToMessageId).toBeNull();
  expect(store.getState().engine.mode).toBe('normal');
});

// The composer grows from two rows to three while replying (Task 6's own
// "one dimmed row above the prompt"). Composer has no explicit height of its
// own -- app.tsx budgets for it via chromeHeight, the same way it already
// does for the which-key overlay's variable height -- so if that budget were
// not updated too, the outer column would be handed one more row of content
// than app.tsx told it it had, which is exactly the overdraw class of bug the
// message view's own rail was rebuilt around.
test('starting a reply shrinks the message pane so the status line stays on its own row, uncorrupted', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('r'); });
  await renderer.flush();
  const rows = renderer.captureCharFrame().split('\n');
  // Row TERMINAL_HEIGHT - 1 is where the status line belongs regardless of
  // reply state -- if chromeHeight had not grown to match the composer's new
  // third row, this row would instead still hold the composer's own prompt,
  // pushed down by one without app.tsx ever finding out.
  expect(rows[TERMINAL_HEIGHT - 1]).toContain('NORMAL');
  expect(rows[TERMINAL_HEIGHT - 1]).toContain(`1/${store.getState().messages.length}`);
});

// Task 7: editing. A single message the user sent themselves -- out: 1 --
// used by every test below that needs something editable.
const ownMessage: IMessageRow = {
  peerId: 'u1', id: 1, fromId: 'me', date: 100, text: 'typo here', out: 1, entities: [], replyToMessageId: null,
};

test('e on an own message loads its text into the composer and enters insert mode', async () => {
  const { renderer, store } = await mount({ messages: [ownMessage] });
  await act(async () => { renderer.mockInput.pressKey('e'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('typo here');
  expect(store.getState().editingMessageId).toBe(1);
  expect(store.getState().engine.mode).toBe('insert');
  expect(store.getState().engine.context).toBe(VimContexts.COMPOSER);
  expect(renderer.captureCharFrame()).toContain('Editing message');
});

test("e on someone else's message does nothing and sets a status message", async () => {
  // The default `messages` fixture (module scope, above) is out: 0
  // throughout -- not the user's own.
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('e'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('');
  expect(store.getState().editingMessageId).toBeNull();
  expect(store.getState().engine.mode).toBe('normal');
  expect(store.getState().statusMessage).toBeTruthy();
});

// The class of bug this guards against: an accidental `e` must not cost the
// user whatever draft they already had, the same way a failed send must not.
test('escape cancels editing and restores the composer to what it held before it started', async () => {
  const { renderer, store } = await mount({ messages: [ownMessage] });
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('draft'); });
  await renderer.flush();
  await pressEscape(renderer);
  expect(store.getState().composerText).toBe('draft');

  await act(async () => { renderer.mockInput.pressKey('e'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('typo here');

  await pressEscape(renderer);
  expect(store.getState().composerText).toBe('draft');
  expect(store.getState().editingMessageId).toBeNull();
  expect(store.getState().engine.mode).toBe('normal');
});

// Final review, Important 2, driven the way the reviewer reproduced it: `e`
// `jk` `e` `<escape>`. The second EDIT_START used to overwrite the saved draft
// with the first message's own text, so this escape handed back "typo here"
// rather than "draft" -- the draft was gone.
test('e twice, then escape, still gives the draft back and not the message text', async () => {
  const { renderer, store } = await mount({ messages: [ownMessage] });
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('draft'); });
  await renderer.flush();
  await pressEscape(renderer);
  expect(store.getState().composerText).toBe('draft');

  await act(async () => { renderer.mockInput.pressKey('e'); });
  await renderer.flush();
  // jk, this author's way out of insert mode, back to NORMAL so `e` binds again.
  await act(async () => {
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('k');
  });
  await renderer.flush();
  expect(store.getState().engine.mode).toBe('normal');

  await act(async () => { renderer.mockInput.pressKey('e'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('typo here');

  await pressEscape(renderer);
  expect(store.getState().composerText).toBe('draft');
  expect(store.getState().editingMessageId).toBeNull();
});

// Mirrors "starting a reply shrinks..." above: the composer grows by one row
// while editing too (its own "Editing message" indicator), and if
// chromeHeight did not grow to match, the status line would lose its own row
// to the composer's new one, silently, rather than failing loudly.
test('starting an edit shrinks the message pane so the status line stays on its own row, uncorrupted', async () => {
  const { renderer, store } = await mount({ messages: [ownMessage] });
  await act(async () => { renderer.mockInput.pressKey('e'); });
  await renderer.flush();
  const rows = renderer.captureCharFrame().split('\n');
  expect(rows[TERMINAL_HEIGHT - 1]).toContain('INSERT');
  expect(rows[TERMINAL_HEIGHT - 1]).toContain(`1/${store.getState().messages.length}`);
});

test('Enter in INSERT while editing replaces the message instead of sending a new one', async () => {
  const { renderer, store, sent, edited } = await mount({ messages: [ownMessage] });
  await act(async () => { renderer.mockInput.pressKey('e'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText(' fixed'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(edited).toEqual([{ messageId: 1, text: 'typo here fixed' }]);
  expect(sent).toEqual([]);
  expect(store.getState().composerText).toBe('');
  expect(store.getState().editingMessageId).toBeNull();
});

// Same regression class as "a send that fails leaves the typed text in the
// composer": a failed edit must not cost the user their edit either.
test('an edit that fails leaves the typed text in the composer', async () => {
  const { renderer, store } = await mount({
    messages: [ownMessage],
    onEdit: async (): Promise<void> => { throw new Error('MESSAGE_NOT_MODIFIED'); },
  });
  await act(async () => { renderer.mockInput.pressKey('e'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText(' fixed'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('typo here fixed');
  expect(store.getState().editingMessageId).toBe(1);
});

// Same regression class as "a second Enter before the first send resolves
// does not send twice": editing shares App's single in-flight guard rather
// than needing a second one of its own.
test('a second Enter before the first edit resolves does not edit twice', async () => {
  const edited: Array<{ messageId: number; text: string }> = [];
  let store!: ApplicationStoreService;
  const onEdit = async (edit: { messageId: number; text: string }): Promise<void> => {
    edited.push(edit);
    await new Promise(resolve => { setTimeout(resolve, SEND_ROUND_TRIP_MILLISECONDS); });
    store.setState({ patch: { composerText: '', editingMessageId: null } });
  };

  const mounted = await mount({ messages: [ownMessage], onEdit });
  store = mounted.store;
  const { renderer } = mounted;

  await act(async () => { renderer.mockInput.pressKey('e'); });
  await renderer.flush();

  // Both presses land in the same synchronous burst, before onEdit's timer
  // has any chance to fire -- exactly the window the regression lives in.
  await act(async () => {
    renderer.mockInput.pressEnter();
    renderer.mockInput.pressEnter();
    await new Promise(resolve => { setTimeout(resolve, SEND_SETTLE_MILLISECONDS); });
  });
  await renderer.flush();

  expect(edited).toEqual([{ messageId: 1, text: 'typo here' }]);
});

// Task 8: delete, behind a confirmation. The behaviour that matters most:
// dd alone must never delete anything.
test('dd asks for confirmation and does not delete yet', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  expect(deleted).toEqual([]);
  expect(store.getState().pendingConfirmation).not.toBeNull();
  expect(renderer.captureCharFrame()).toContain('Delete');
});

test('y confirms and deletes', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(deleted).toHaveLength(1);
  expect(store.getState().pendingConfirmation).toBeNull();
});

test('n cancels and deletes nothing', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('n'); });
  await renderer.flush();
  expect(deleted).toEqual([]);
  expect(store.getState().pendingConfirmation).toBeNull();
});

// The load-bearing guard: a stray key while the confirmation is up must not
// reach the message that will be under the cursor once it is answered --
// which might not be the message the confirmation was actually about.
test('while a confirmation is pending, j does not move the cursor', async () => {
  const { renderer, store } = await mount();
  const before = store.getState().messageCursor;
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(before);
});

// Same class of key as the which-key overlay's own escape and the reply/edit
// cancels above: App-level state a static keymap binding cannot see.
test('escape cancels a pending delete confirmation', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await pressEscape(renderer);
  expect(deleted).toEqual([]);
  expect(store.getState().pendingConfirmation).toBeNull();
});

// The other half of the swallow guard: it must let go again once answered,
// not leave every key dead for the rest of the session.
test('after n cancels, j moves the cursor again', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('n'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(1);
});

// The confirmation reuses the status line's existing single row (no new
// chrome row to budget -- see the comment on StatusLine's confirming prop),
// so the only on-screen sign this is the irreversible one is colour.
test('the status line turns the danger colour while a delete is pending confirmation', async () => {
  const { renderer } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  const statusRow = renderer.captureSpans().lines[TERMINAL_HEIGHT - 1]!;
  const span = statusRow.spans.find(candidate => candidate.text.includes('Delete'));
  expect(span).toBeDefined();
  expect(rgbToHex(span!.fg).toLowerCase()).toBe(tokens.error.toLowerCase());
});

// --- M1b-2 Task 4: doubled operators (dd/yy/cc) -----------------------------
//
// dd's own confirmation (M1b-1's guarantee) must survive operators becoming
// a second way to reach it: a count must not become a route around asking.
test('3dd asks for confirmation instead of deleting three messages outright', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('3');
    renderer.mockInput.pressKey('d');
    renderer.mockInput.pressKey('d');
  });
  await renderer.flush();
  expect(deleted).toEqual([]);
  expect(store.getState().pendingConfirmation).not.toBeNull();
  expect(store.getState().messages).toHaveLength(4);
  expect(renderer.captureCharFrame()).toContain('Delete');
});

// The other half, and the one the feature actually turns on: through M1b-2 the
// test above was the whole story, and answering y deleted a single message.
// Driven end to end through real key presses rather than the reducer alone --
// the count has to survive the engine, the operator, App's CONFIRM handler and
// onDelete's signature, and any one of those dropping it looks identical from
// the reducer's side.
test('3dd then y deletes three messages, and says three before it does', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('3');
    renderer.mockInput.pressKey('d');
    renderer.mockInput.pressKey('d');
  });
  await renderer.flush();

  expect(store.getState().pendingConfirmation).toEqual({ kind: 'delete', messageIds: [1, 2, 3] });
  expect(renderer.captureCharFrame()).toContain('Delete 3 messages?');

  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();

  expect(deleted).toEqual([{ messageIds: [1, 2, 3] }]);
});

// Answering n after asking for three must delete none of them -- a count is
// not a route around the question (M1b-1's guarantee), in either direction.
test('3dd then n deletes nothing at all', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('3');
    renderer.mockInput.pressKey('d');
    renderer.mockInput.pressKey('d');
  });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('n'); });
  await renderer.flush();

  expect(deleted).toEqual([]);
  expect(store.getState().pendingConfirmation).toBeNull();
});

// The Minor from M1b-1's final review, driven through real key presses: dd
// used to be `context: '*'`, so pressing it while focused on the chat list
// deleted a message in the messages pane the cursor was not even in.
// Operators make this more reachable, not less (bare d/y/c commit with no
// per-context keymap entry to filter them at all), so this must hold now.
test('dd does nothing while focused on the chat list', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('n');
    renderer.mockInput.pressKey('f');
  });
  await renderer.flush();
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);

  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();

  expect(store.getState().pendingConfirmation).toBeNull();
  expect(deleted).toEqual([]);
  expect(store.getState().messages).toHaveLength(4);
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);
});

// M1b-2 Task 5: registers. An unnamed yy writes UNNAMED_REGISTER, vim's own
// name for the unnamed register -- exactly what this always did before
// named registers existed, just under a different key.
test('yy yanks the message under the cursor into the default register', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('y'); renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(store.getState().registers['"']).toBe('msg1');
});

// The same count guarantee dd needs, proven end to end through an operator
// that (unlike delete) actually acts on the full range: two messages come
// back joined, not the anchor alone and not four.
test('2yy yanks two messages, not four', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('2');
    renderer.mockInput.pressKey('y');
    renderer.mockInput.pressKey('y');
  });
  await renderer.flush();
  expect(store.getState().registers['"']).toBe('msg1\nmsg2');
});

// --- M1b-2 Task 5: registers -------------------------------------------------

// "ayy: a named register, not the default one -- the brief's own headline example.
test('"ayy yanks into register a, not the default register', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('"');
    renderer.mockInput.pressKey('a');
    renderer.mockInput.pressKey('y');
    renderer.mockInput.pressKey('y');
  });
  await renderer.flush();
  expect(store.getState().registers.a).toBe('msg1');
  expect(store.getState().registers['"']).toBeUndefined();
});

// Decision 2 (task-5-brief.md): a register name must not survive a cancelled
// operation. Proven end to end: after "a, escape, and an entirely unrelated
// yy, the text must land in the default register, not register a.
test('"a then escape does not leave a register pending for a later, unrelated yy', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('"');
    renderer.mockInput.pressKey('a');
  });
  await renderer.flush();
  expect(store.getState().engine.register).toBe('a');

  await pressEscape(renderer);
  expect(store.getState().engine.register).toBeNull();

  await act(async () => { renderer.mockInput.pressKey('y'); renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(store.getState().registers.a).toBeUndefined();
  expect(store.getState().registers['"']).toBe('msg1');
});

// Decision 3 (task-5-brief.md): registers follow the same M1b-1 rule
// operators do -- dd already does nothing from the chat list (above); "
// must not do anything there either.
test('" does nothing while focused on the chat list', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('n'); renderer.mockInput.pressKey('f'); });
  await renderer.flush();
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);

  await act(async () => { renderer.mockInput.pressKey('"'); renderer.mockInput.pressKey('a'); });
  await renderer.flush();
  expect(store.getState().engine.register).toBeNull();
});

// Decision 1 (task-5-brief.md): delete also writes to a register, named when
// "a preceded it, and does so immediately -- not gated on the confirmation
// that follows, since the register is a harmless, local, freely-overwritable
// value, unlike the confirmation guarding the one irreversible, networked
// effect.
test('"add writes the deleted message into register a immediately, not gated on the confirmation', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('"');
    renderer.mockInput.pressKey('a');
    renderer.mockInput.pressKey('d');
    renderer.mockInput.pressKey('d');
  });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).not.toBeNull();
  expect(store.getState().registers.a).toBe('msg1');
  expect(deleted).toEqual([]);

  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(deleted).toHaveLength(1);
  expect(store.getState().registers.a).toBe('msg1');
});

// --- M1b-2 Task 6: system clipboard ------------------------------------------
//
// copyToClipboardOSC52 is a plain, mutable instance method (not readonly), so
// reassigning it on the real (test) renderer is type-safe with no cast and no
// subclass -- the same pattern mount()'s own extraBindings support uses for
// KeymapService.getBindings. Stubbing it here also means these tests never
// depend on the test renderer's own OSC 52 capability detection: the real
// implementation checks isOsc52Supported() and no-ops if it is ever false,
// which this stub bypasses entirely by never calling through to it.
test('"+yy copies the yanked message to the system clipboard, not just the register', async () => {
  const { renderer, store } = await mount();
  const copied: string[] = [];
  renderer.renderer.copyToClipboardOSC52 = (text: string): boolean => { copied.push(text); return true; };

  await act(async () => {
    renderer.mockInput.pressKey('"');
    renderer.mockInput.pressKey('+');
    renderer.mockInput.pressKey('y');
    renderer.mockInput.pressKey('y');
  });
  await renderer.flush();

  expect(store.getState().registers['+']).toBe('msg1');
  expect(copied).toEqual(['msg1']);
});

// The ordinary case (Task 5's own default-register yy) must not gain a side
// effect it never had: only the register named `+` reaches the clipboard.
test('a plain yy (default register) does not touch the system clipboard', async () => {
  const { renderer, store } = await mount();
  const copied: string[] = [];
  renderer.renderer.copyToClipboardOSC52 = (text: string): boolean => { copied.push(text); return true; };

  await act(async () => { renderer.mockInput.pressKey('y'); renderer.mockInput.pressKey('y'); });
  await renderer.flush();

  expect(store.getState().registers['"']).toBe('msg1');
  expect(copied).toEqual([]);
});

// Delete writes a register exactly as yank does (Task 5, above), so "+dd
// must copy to the clipboard exactly as "+yy does -- and, like "add's own
// register write, immediately on OPERATOR_APPLY resolving, not gated on the
// y/n confirmation that follows (the confirmation guards only the one
// irreversible, networked effect; the register and the clipboard write it now
// drives are both harmless, local, freely-overwritable side effects).
test('"+dd copies the deleted message to the system clipboard immediately, not gated on the confirmation', async () => {
  const { renderer, store, deleted } = await mount();
  const copied: string[] = [];
  renderer.renderer.copyToClipboardOSC52 = (text: string): boolean => { copied.push(text); return true; };

  await act(async () => {
    renderer.mockInput.pressKey('"');
    renderer.mockInput.pressKey('+');
    renderer.mockInput.pressKey('d');
    renderer.mockInput.pressKey('d');
  });
  await renderer.flush();

  expect(store.getState().pendingConfirmation).not.toBeNull();
  expect(store.getState().registers['+']).toBe('msg1');
  expect(copied).toEqual(['msg1']);
  expect(deleted).toEqual([]);
});

// --- M1b-2 Task 7: `.` repeats the last change -------------------------------
//
// Task 5's own report found a bug an engine-only test could not have caught:
// REGISTER_SET briefly resolved with status 'pending', which app.tsx's
// commitResolution silently drops (it only ever runs a result's actions when
// status is 'resolved'). `.` carries the identical risk, so every test below
// drives it through real key presses against the real store rather than
// calling engine.resolve() directly -- if `.` ever regressed to 'pending',
// every assertion here that checks an actual mutation would fail.

test('. with no prior change does nothing, silently', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('.'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).toBeNull();
  expect(store.getState().messageCursor).toBe(0);
  expect(store.getState().registers).toEqual({});
  expect(deleted).toEqual([]);
});

// Requirement 1: a motion is not a change. If `j` were mistakenly recorded as
// one, `.` here would move the cursor a second time.
test('a motion (j) is not a change -- . after it does nothing', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(1);

  await act(async () => { renderer.mockInput.pressKey('.'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(1);
  expect(store.getState().pendingConfirmation).toBeNull();
});

// M1b-1's guarantee, tested explicitly a third time (Tasks 4 and 5 both
// already had to preserve it): a repeated delete must still confirm, not
// delete outright.
test('. repeating a delete still asks for confirmation -- it does not delete outright', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(deleted).toEqual([{ messageIds: [1] }]);

  await act(async () => { renderer.mockInput.pressKey('.'); });
  await renderer.flush();
  expect(deleted).toEqual([{ messageIds: [1] }]); // not yet a second delete
  expect(store.getState().pendingConfirmation).not.toBeNull();
  expect(renderer.captureCharFrame()).toContain('Delete');

  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(deleted).toHaveLength(2);
});

// Requirement 3, the brief's own example: dd, j, . must delete the message
// now under the cursor, not the one dd originally targeted. onDelete never
// removes anything from state.messages in this stub (matching every other
// dd test in this file), so messageCursor 1 after `j` is msg2 -- a repeat
// that still targeted msg1 would prove the engine replayed an absolute
// target instead of a cursor-relative delta.
test('. after dd repeats on the message now under the cursor, not the original one', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).toEqual({ kind: 'delete', messageIds: [1] });
  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();

  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(1);

  await act(async () => { renderer.mockInput.pressKey('.'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).toEqual({ kind: 'delete', messageIds: [2] });

  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(deleted).toEqual([{ messageIds: [1] }, { messageIds: [2] }]);
});

// Requirement 5 (task-7-brief.md's own open question) -- decision: a
// cancelled delete still counts as the last change. lastChange is recorded
// the instant OPERATOR_APPLY resolves (vim-engine.ts's recordChange), before
// App ever asks for confirmation -- the identical timing Task 5 already
// relies on for a register write surviving a cancelled dd ("a cancelled dd
// still 'copies' the message", action-reducer.ts). Real vim's own `.` has no
// concept of a cancelled change to begin with, since nothing in stock vim
// gates a change behind a y/n prompt; tglow's confirmation is a layer on top
// of that, and it reapplies independently on the repeat too (the second
// assertion below), so nothing unsafe follows from treating the cancelled
// attempt as real.
test('. after a cancelled (n) delete still repeats it -- and still asks again', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('n'); });
  await renderer.flush();
  expect(deleted).toEqual([]);
  expect(store.getState().pendingConfirmation).toBeNull();

  await act(async () => { renderer.mockInput.pressKey('.'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).toEqual({ kind: 'delete', messageIds: [1] });
  expect(deleted).toEqual([]);
});

// A bare `.` repeats the exact recorded range verbatim -- 2yy's own count
// stays 2, not reset to 1.
test('2yy then a bare . repeats the same two-message range', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('2');
    renderer.mockInput.pressKey('y');
    renderer.mockInput.pressKey('y');
  });
  await renderer.flush();
  expect(store.getState().registers['"']).toBe('msg1\nmsg2');

  await act(async () => { renderer.mockInput.pressKey('.'); });
  await renderer.flush();
  expect(store.getState().registers['"']).toBe('msg1\nmsg2');
});

// The brief's own headline, end to end: a freshly typed count replaces the
// recorded one -- 3. after a plain (count-1) yy yanks three messages, not
// one and not the original range multiplied.
test('3. after a plain yy replaces the count with three', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('y'); renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(store.getState().registers['"']).toBe('msg1');

  await act(async () => {
    renderer.mockInput.pressKey('3');
    renderer.mockInput.pressKey('.');
  });
  await renderer.flush();
  expect(store.getState().registers['"']).toBe('msg1\nmsg2\nmsg3');
});

// Operators do nothing from the chat list (M1b-1's guarantee, preserved by
// Tasks 3-5); `.` re-emits an operator application, so it follows the same
// rule.
test('. does nothing while focused on the chat list', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();

  await act(async () => { renderer.mockInput.pressKey('n'); renderer.mockInput.pressKey('f'); });
  await renderer.flush();
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);

  await act(async () => { renderer.mockInput.pressKey('.'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).toBeNull();
  expect(deleted).toEqual([{ messageIds: [1] }]);
});

// `.` must still reach the composer as a literal character in INSERT mode --
// otherwise "end of sentence." would silently lose its period.
test('. in insert mode reaches the composer as literal text', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await act(async () => { await renderer.mockInput.typeText('hi.'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('hi.');
});

test('cc on an own message loads it into the composer for editing, same as e', async () => {
  const { renderer, store } = await mount({ messages: [ownMessage] });
  await act(async () => { renderer.mockInput.pressKey('c'); renderer.mockInput.pressKey('c'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('typo here');
  expect(store.getState().editingMessageId).toBe(1);
  expect(store.getState().engine.mode).toBe('insert');
});

test("cc on someone else's message refuses and sets a status message, same as e", async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('c'); renderer.mockInput.pressKey('c'); });
  await renderer.flush();
  expect(store.getState().editingMessageId).toBeNull();
  expect(store.getState().engine.mode).toBe('normal');
  expect(store.getState().statusMessage).toBeTruthy();
});

// --- Task 2 (M1b-2): the ambiguous-key timeout, vim's own timeoutlen -------
//
// Stale as of Task 3, corrected in Task 4: the real keymap does have an
// ambiguous sequence now -- a bare `d` against the real `dd` (Task 3 made
// d/y/c live operator triggers; dd stays a literal binding rather than
// folding into that doubled-operator recognition, exactly so this ambiguity
// stays real -- see keymap.ts's own comment on the dd binding). But
// resolving `d` by itself commits only to operator-pending state
// (engine.operator), with no action of its own to observe --
// flushPending's `pending` status, not `resolved`. These tests need the
// short half to have an observable effect, to tell "the short binding
// fired" apart from "the long one did" on two independent fields, so they
// still extend the real keymap with one test-only binding for bare `d`
// rather than relying on the real, actionless one. Its action (CURSOR_EDGE
// 'last') is deliberately unlike dd's own OPERATOR_APPLY, so the two
// effects -- and which one, if either, actually ran -- are distinguishable
// on messageCursor and pendingConfirmation independently.
const AMBIGUOUS_SHORT_D_BINDING: IKeyBinding = {
  context: '*',
  mode: VimModes.NORMAL,
  keys: 'd',
  description: 'test-only: short half of the d/dd ambiguity',
  action: () => [{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'last' }],
};

// Comfortably past TIMEOUT_MILLISECONDS (400) so the wait is never close
// enough to flake.
const PAST_TIMEOUT_MILLISECONDS = 500;

test('an ambiguous key resolves the short binding after the timeout', async () => {
  const { renderer, store } = await mount({ extraBindings: [AMBIGUOUS_SHORT_D_BINDING] });
  await act(async () => { renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).toBeNull();   // dd has not fired
  expect(store.getState().messageCursor).toBe(0);            // nor has the short binding, yet

  await act(async () => { await new Promise(resolve => setTimeout(resolve, PAST_TIMEOUT_MILLISECONDS)); });
  await renderer.flush();
  // The short binding's own effect: CURSOR_EDGE 'last' moves the cursor to
  // the newest message.
  expect(store.getState().messageCursor).toBe(store.getState().messages.length - 1);
  expect(store.getState().pendingConfirmation).toBeNull();
});

test('a second key beats the timer and resolves the longer binding', async () => {
  const { renderer, store } = await mount({ extraBindings: [AMBIGUOUS_SHORT_D_BINDING] });
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).not.toBeNull();  // dd fired
  expect(store.getState().messageCursor).toBe(0);                // the short binding never ran
});

// The load-bearing test. Without clearing the timer on every key press, the
// first `d`'s timer is still armed when the second `d` resolves dd a moment
// later, and fires the short binding's own CURSOR_EDGE on top of it once the
// clock runs out -- moving the cursor as a second effect of one dd. Verified
// by temporarily deleting the clear in app.tsx and re-running this file:
// this test failed on messageCursor (3, not 0) with that clear removed, and
// passed again once it was restored.
test('the timer is cancelled when a key arrives, so the short binding never also fires', async () => {
  const { renderer, store } = await mount({ extraBindings: [AMBIGUOUS_SHORT_D_BINDING] });
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, PAST_TIMEOUT_MILLISECONDS)); });
  await renderer.flush();
  // Exactly one confirmation, from dd alone -- and the cursor, which dd's
  // own binding never touches, is still where it started: not moved by a
  // late-firing short d.
  expect(store.getState().pendingConfirmation).not.toBeNull();
  expect(store.getState().messageCursor).toBe(0);
});

test('unmounting clears a running timer', async () => {
  const { renderer } = await mount({ extraBindings: [AMBIGUOUS_SHORT_D_BINDING] });
  await act(async () => { renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  // destroy() unmounts the React root still attached to this renderer, so it
  // needs act() around it too -- the same rule render.tsx's own helper
  // follows when it tears down the previous test's renderer -- or React
  // warns that an update to Root escaped act(), independent of anything this
  // task changed.
  act(() => {
    expect(() => renderer.renderer.destroy()).not.toThrow();
  });
});

test('i enters INSERT and jk returns to NORMAL', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  expect(store.getState().engine.mode).toBe('insert');
  expect(renderer.captureCharFrame()).toContain('INSERT');

  await act(async () => {
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('k');
  });
  await renderer.flush();
  expect(store.getState().engine.mode).toBe('normal');
  // The flush rule below must not make the escape hatch type its own keys.
  expect(store.getState().composerText).toBe('');
});

// Final review, Critical 1: `jk` is bound in INSERT, so the engine holds a
// bare `j` as a pending prefix -- and App's pending branch stored the engine
// state without ever emitting the character. Every j a user typed vanished:
// "enjoy" arrived as "enoy". These four drive real key presses through App,
// because the engine's own tests use a local keymap that omits `jk`, which is
// exactly how a bug this loud survived 164 passing tests.
test('a j inside a word reaches the composer instead of being swallowed', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('enjoy'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('enjoy');
});

test('two j presses leave both characters in the composer', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('jj'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('jj');
});

// A dead prefix must not cost a second Escape: ['j', '<escape>'] is unmapped
// and \x1b is not printable, so before the flush rule the first Escape did
// nothing at all and INSERT persisted.
test('one Escape leaves INSERT after a lone j', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  await pressEscape(renderer);
  expect(store.getState().engine.mode).toBe('normal');
  expect(store.getState().composerText).toBe('j');
});

test('typing in INSERT reaches the composer and does not move the cursor', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('hey'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('hey');
  expect(store.getState().messageCursor).toBe(0);
});

test('Enter in INSERT sends the composed text and the sender clears the composer', async () => {
  const { renderer, store, sent, composerAtSend } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('on my way'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(sent).toEqual(['on my way']);
  // App hands the text over and touches nothing: the composer must still hold
  // it when the service looks, or the service's "only clear what is still
  // there" check can never be true. It was dead code in production for
  // exactly that reason.
  expect(composerAtSend).toEqual(['on my way']);
  expect(store.getState().composerText).toBe('');
});

// Final review, Critical 3: App cleared composerText the moment Enter was
// pressed, before the send had even been attempted, so a rejected send left
// the user with an empty composer and nothing to retry. Task 13 built
// MessageService around never losing typed text; its test passed because it
// called the service directly and never went through App.
test('a send that fails leaves the typed text in the composer', async () => {
  const { renderer, store } = await mount({
    onSend: async (): Promise<void> => { throw new Error('FLOOD_WAIT_30'); },
  });
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('hello'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('hello');
});

// Regression from the C3 fix above: App stopped clearing the composer so
// MessageService could own it, but the service clears only after the network
// round-trip -- so for that whole window the composer still holds the text,
// with nothing on screen to say a send is in flight. A second Enter before
// the first resolves re-dispatches COMPOSER_SEND with the same non-empty
// string, which MessageService's own comment calls unrecoverable. `store` is
// assigned after `mount()` resolves but read inside `onSend`, which only
// ever runs on a later Enter press -- by the time that happens the
// assignment below has long since landed.
test('a second Enter before the first send resolves does not send twice', async () => {
  const sent: string[] = [];
  let store!: ApplicationStoreService;
  const onSend = async (text: string): Promise<void> => {
    sent.push(text);
    await new Promise(resolve => { setTimeout(resolve, SEND_ROUND_TRIP_MILLISECONDS); });
    store.setState({ patch: { composerText: '' } });
  };

  const mounted = await mount({ onSend });
  store = mounted.store;
  const { renderer } = mounted;

  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('hi'); });
  await renderer.flush();

  // Both presses land in the same synchronous burst, before onSend's timer
  // has any chance to fire -- exactly the window the regression lives in.
  await act(async () => {
    renderer.mockInput.pressEnter();
    renderer.mockInput.pressEnter();
    await new Promise(resolve => { setTimeout(resolve, SEND_SETTLE_MILLISECONDS); });
  });
  await renderer.flush();

  expect(sent).toEqual(['hi']);
});

// The other half of the guard: a flag that only ever gets set, never cleared
// on the failure path, would leave the composer permanently unable to send
// again -- worse than the duplicate it exists to prevent.
test('a later Enter can send again after a send that rejects', async () => {
  const sent: string[] = [];
  let rejectNextSend = true;
  let store!: ApplicationStoreService;
  const onSend = async (text: string): Promise<void> => {
    await new Promise(resolve => { setTimeout(resolve, SEND_ROUND_TRIP_MILLISECONDS); });
    if (rejectNextSend) {
      throw new Error('FLOOD_WAIT_30');
    }
    sent.push(text);
    store.setState({ patch: { composerText: '' } });
  };

  const mounted = await mount({ onSend });
  store = mounted.store;
  const { renderer } = mounted;

  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('hi'); });
  await renderer.flush();

  await act(async () => {
    renderer.mockInput.pressEnter();
    await new Promise(resolve => { setTimeout(resolve, SEND_SETTLE_MILLISECONDS); });
  });
  await renderer.flush();
  expect(sent).toEqual([]);
  expect(store.getState().composerText).toBe('hi');

  rejectNextSend = false;
  await act(async () => {
    renderer.mockInput.pressEnter();
    await new Promise(resolve => { setTimeout(resolve, SEND_SETTLE_MILLISECONDS); });
  });
  await renderer.flush();

  expect(sent).toEqual(['hi']);
});

// Code review on Task 16: the printable check relied on !ctrl alone, but Tab
// and linefeed arrive with ctrl:false, so a raw tab could reach a sent
// message. isPrintableCharacter's code-point range check is what excludes it.
test('Tab in INSERT does not alter the composer', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressTab(); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('');
});

test('Backspace in INSERT removes the last character', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('hi'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressBackspace(); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('h');
});

test('return in the chat list opens the chat and moves focus to messages', async () => {
  const { renderer, store, opened } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('n');
    renderer.mockInput.pressKey('f');
  });
  await renderer.flush();
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);

  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(opened).toEqual(['u1']);
  expect(store.getState().engine.context).toBe(VimContexts.MESSAGES);
});

// Task 9: mark as read. onMarkRead is chained onto onOpenChat's own promise
// and reads the store afresh once it resolves -- this onOpenChat fake
// populates a distinct message list from what mount() seeded, so a pass here
// proves App reads the post-load messages, not a stale pre-open snapshot.
test('opening a chat marks its newest message read', async () => {
  const loaded: IMessageRow[] = [1, 2].map(id => ({
    peerId: 'u1', id, fromId: 'u1', date: id * 100, text: `loaded${id}`, out: 0, entities: [], replyToMessageId: null,
  }));
  const { renderer, store, marked } = await mount({
    onOpenChat: async chat => {
      store.setState({ patch: { messages: loaded, activePeerId: chat.peerId } });
    },
  });
  await act(async () => {
    renderer.mockInput.pressKey('n');
    renderer.mockInput.pressKey('f');
  });
  await renderer.flush();
  await act(async () => {
    renderer.mockInput.pressEnter();
    await new Promise(resolve => { setTimeout(resolve, MARK_READ_SETTLE_MILLISECONDS); });
  });
  await renderer.flush();
  expect(marked).toEqual([{ peerId: 'u1', maxId: 2 }]);
});

// The behaviour that matters most: reading is an explicit act, and the chat
// list is not the chat. A stray j/k while browsing chats -- never opening one
// -- must not mark anything read.
test('moving the cursor within the chat list does not mark anything read', async () => {
  const { renderer, marked } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('n');
    renderer.mockInput.pressKey('f');
  });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('k'); });
  await renderer.flush();
  expect(marked).toEqual([]);
});

/**
 * Final review, Important 1. gg/G/<C-d>/<C-u> are `context: '*'` bindings
 * carrying `unit: 'message'` (keymap.ts), so they move the message cursor from
 * the chat list too -- and App gated markRead on the unit alone. Four
 * keystrokes of browsing acked the open chat without the user ever looking at
 * it, which is exactly the never-auto-read guarantee Task 9 exists for. Each
 * key is its own case: a gate that only excluded CURSOR_EDGE would leave
 * <C-d>/<C-u> (CURSOR_MOVE) still doing it.
 */
for (const browse of [
  { name: '<S-g>', press: (renderer: TestRendererSetup): void => { renderer.mockInput.pressKey('g', { shift: true }); } },
  { name: 'gg', press: (renderer: TestRendererSetup): void => {
    renderer.mockInput.pressKey('g');
    renderer.mockInput.pressKey('g');
  } },
  { name: '<C-d>', press: (renderer: TestRendererSetup): void => { renderer.mockInput.pressKey('d', { ctrl: true }); } },
  { name: '<C-u>', press: (renderer: TestRendererSetup): void => { renderer.mockInput.pressKey('u', { ctrl: true }); } },
]) {
  test(`${browse.name} from the chat list does not mark the open chat read`, async () => {
    const { renderer, store, marked } = await mount();
    await act(async () => {
      renderer.mockInput.pressKey('n');
      renderer.mockInput.pressKey('f');
    });
    await renderer.flush();
    expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);

    await act(async () => { browse.press(renderer); });
    await renderer.flush();

    expect(marked).toEqual([]);
  });
}

// The other half of the same gate: the message pane is where reading happens,
// and this must keep working exactly as it did.
test('<S-g> still marks read once focus is back on the messages pane', async () => {
  const { renderer, marked } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('n');
    renderer.mockInput.pressKey('f');
  });
  await renderer.flush();
  await act(async () => {
    renderer.mockInput.pressKey('w', { ctrl: true });
    renderer.mockInput.pressKey('l');
  });
  await renderer.flush();

  await act(async () => { renderer.mockInput.pressKey('g', { shift: true }); });
  await renderer.flush();

  expect(marked).toEqual([{ peerId: 'u1', maxId: 4 }]);
});

test('opening a chat with no messages yet does not mark anything read', async () => {
  const { renderer, marked } = await mount({ messages: [], onOpenChat: async () => {} });
  await act(async () => {
    renderer.mockInput.pressKey('n');
    renderer.mockInput.pressKey('f');
  });
  await renderer.flush();
  await act(async () => {
    renderer.mockInput.pressEnter();
    await new Promise(resolve => { setTimeout(resolve, MARK_READ_SETTLE_MILLISECONDS); });
  });
  await renderer.flush();
  expect(marked).toEqual([]);
});

// Final review, Critical 2: the panes rendered every row and App never told
// them how many rows they had, so main.ts's 200-message history went into
// roughly ten. The pane tests cover the window itself; this one covers the
// wiring, which is the half that was actually missing.
test('a history longer than the pane scrolls to keep the cursor on screen', async () => {
  const { renderer, store } = await mount({ messages: history });
  expect(renderer.captureCharFrame()).toContain('msg001');

  // <S-g> is the newest-message binding: OpenTUI reports a shifted letter
  // lowercased with shift set separately, never a bare 'G'.
  await act(async () => { renderer.mockInput.pressKey('g', { shift: true }); });
  await renderer.flush();

  expect(store.getState().messageCursor).toBe(history.length - 1);
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('msg200');
  expect(frame).not.toContain('msg001');
});

test('<S-g> jumps to the newest message and marks it read', async () => {
  const { renderer, marked } = await mount({ messages: history });
  await act(async () => { renderer.mockInput.pressKey('g', { shift: true }); });
  await renderer.flush();
  expect(marked).toEqual([{ peerId: 'u1', maxId: history.length }]);
});

// Cursor movement inside the open chat, landing on its newest message, is the
// other of the two triggers -- distinct from CHAT_OPEN above (no chat is
// (re)opened here at all).
test('moving the cursor to the newest message marks it read', async () => {
  const { renderer, store, marked } = await mount();
  expect(store.getState().messageCursor).toBe(0);
  await act(async () => {
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('j');
  });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(3);
  // Only the final press actually lands on the newest (last) message --
  // the two before it must not have fired.
  expect(marked).toEqual([{ peerId: 'u1', maxId: 4 }]);
});

// Debounce lives on MessageService (Task 9's brief), not here -- App fires
// onMarkRead every qualifying time, relying on the service to collapse
// repeats, the same split the brief draws between "when" and "how often".
test('the cursor already at the newest message marks it read again on the next qualifying move', async () => {
  const { renderer, marked } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('j');
  });
  await renderer.flush();
  expect(marked).toHaveLength(1);

  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(marked).toHaveLength(2);
  expect(marked[1]).toEqual({ peerId: 'u1', maxId: 4 });
});

// --- Final review, Critical 2: the warning must reach the screen -----------

test('a data-integrity warning is shown on the status line', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    store.setState({ patch: { integrityWarning: 'Some missed messages could not be saved' } });
  });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('Some missed messages could not be saved');
});

// The half loadHistory used to erase: an ordinary status message coming and
// going must not take the warning with it.
test('the warning is still on the status line after a transient status message clears', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    store.setState({
      patch: { integrityWarning: 'some history may be missing', statusMessage: 'Send failed: offline' },
    });
  });
  await renderer.flush();

  // Exactly what MessageService.loadHistory's success patch does, and the
  // patch that used to wipe the warning out entirely.
  await act(async () => { store.setState({ patch: { statusMessage: null } }); });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('some history may be missing');
});

/**
 * The ordering choice, pinned rather than left to accident. Most of
 * statusMessage is sticky -- "No link in this message", "Can only edit your
 * own messages", "Send failed: …" are cleared only by the *next* successful
 * load or send -- so a warning ranked below them would be one keystroke away
 * from being hidden for the rest of the session, which is the bug this field
 * exists to fix wearing a different hat. <C-l> is how the user gets the status
 * line back.
 */
test('the warning outranks an ordinary status message until it is dismissed', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    store.setState({
      patch: { integrityWarning: 'some history may be missing', statusMessage: 'No link in this message' },
    });
  });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('some history may be missing');

  await act(async () => { renderer.mockInput.pressKey('l', { ctrl: true }); });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('No link in this message');
});

// The delete confirmation is the only thing the user has to answer, so it
// outranks even this -- a swallowed y/n prompt is its own bug.
test('a pending delete confirmation still outranks the warning', async () => {
  const { renderer, store } = await mount();
  await act(async () => { store.setState({ patch: { integrityWarning: 'some history may be missing' } }); });
  await renderer.flush();
  await act(async () => {
    renderer.mockInput.pressKey('d');
    renderer.mockInput.pressKey('d');
  });
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('Delete this message?');
  expect(frame).not.toContain('some history may be missing');
});

test('<C-l> dismisses the warning, and only the user can', async () => {
  const { renderer, store } = await mount();
  await act(async () => { store.setState({ patch: { integrityWarning: 'some history may be missing' } }); });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('some history may be missing');

  await act(async () => { renderer.mockInput.pressKey('l', { ctrl: true }); });
  await renderer.flush();

  expect(store.getState().integrityWarning).toBeNull();
  expect(renderer.captureCharFrame()).not.toContain('some history may be missing');
});

test('<C-c> quits the application', async () => {
  const { renderer, quit } = await mount();
  await act(async () => { renderer.mockInput.pressCtrlC(); });
  await renderer.flush();
  expect(quit).toEqual([true]);
});

// The which-key popup: `\` was rendered as a promised hint on the status bar
// ("\ for keys") while bound to nothing at all -- these four are the reported
// bug and its fix, driven through real key presses rather than KeymapService
// directly, because that is the layer the bug actually lived in.
test('\\ opens the which-key overlay, showing bindings for the current mode and pane', async () => {
  const { renderer } = await mount();
  await act(async () => { renderer.mockInput.pressKey('\\'); });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('Next message');
});

test('\\ a second time closes the overlay again', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('\\'); });
  await renderer.flush();
  expect(store.getState().overlay).toBe('whichkey');

  await act(async () => { renderer.mockInput.pressKey('\\'); });
  await renderer.flush();
  expect(store.getState().overlay).toBeNull();
  expect(renderer.captureCharFrame()).not.toContain('Next message');
});

test('escape closes the overlay', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('\\'); });
  await renderer.flush();
  expect(store.getState().overlay).toBe('whichkey');

  await pressEscape(renderer);
  expect(store.getState().overlay).toBeNull();
});

test('while the overlay is open, j does not move the message cursor', async () => {
  const { renderer, store } = await mount();
  expect(store.getState().messageCursor).toBe(0);

  await act(async () => { renderer.mockInput.pressKey('\\'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();

  expect(store.getState().messageCursor).toBe(0);
});

// The chat list has its own <escape> binding (back to messages, added by
// this same task). Closing the overlay must take priority over it outright,
// not run alongside it -- otherwise dismissing the popup from the chat list
// would also silently refocus the messages pane underneath it.
test('escape closes the overlay without also refocusing the pane underneath it', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('n');
    renderer.mockInput.pressKey('f');
  });
  await renderer.flush();
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);

  await act(async () => { renderer.mockInput.pressKey('\\'); });
  await renderer.flush();
  expect(store.getState().overlay).toBe('whichkey');

  await pressEscape(renderer);
  expect(store.getState().overlay).toBeNull();
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);
});

// task-discoverability-report.md: M1b-2's operators (d/y/c), their doubled
// whole-message forms (yy/cc -- dd already had a real binding), the register
// prefix (") and repeat (.) are all engine-intrinsic (vim-engine.ts): resolved
// with no entry in the keymap table at all, the same way a digit count needs
// none. That meant describe() -- and so this popup -- could not see them; only
// `dd` had a keymap entry, and `\` reflects the keymap, not vim-engine.ts.
// KeymapService now folds a separate, display-only descriptor list into
// describe()'s own output (keymap.ts) so the popup can advertise them too.
//
// This goes through App and real key presses, not describe() directly,
// because the reported gap was the popup failing to *render* what describe()
// already returned -- a test on describe()'s return value alone would not
// have caught a rendering-side failure to pick the new entries up. mount()
// needs the wider terminal here (see WIDE_TERMINAL_WIDTH/HEIGHT's own
// comment): at the default size the popup's own rows overflow the captured
// frame long before reaching these entries, which describe() appends after
// every table-driven one.
test('the which-key popup lists the engine-intrinsic operator, register and repeat keys', async () => {
  const { renderer, store } = await mount({ width: WIDE_TERMINAL_WIDTH, height: WIDE_TERMINAL_HEIGHT });
  expect(store.getState().engine.context).toBe(VimContexts.MESSAGES);

  await act(async () => { renderer.mockInput.pressKey('\\'); });
  await renderer.flush();

  const frame = renderer.captureCharFrame();
  expect(frame).toContain('Delete with motion');
  expect(frame).toContain('Yank with motion');
  expect(frame).toContain('Change with motion');
  expect(frame).toContain('Yank message');
  expect(frame).toContain('Change message');
  expect(frame).toContain('Choose a register');
  expect(frame).toContain('Repeat last change');
});

// --- M1b-2 Task 8: <C-p>, fuzzy jump to any chat -----------------------------
//
// The owner's own chat list is mostly Vietnamese (task-8-brief.md) -- this
// fixture mirrors that, rather than an all-ASCII stand-in, so the tests below
// exercise the actual reason the feature exists, not just wiring in the
// abstract. 'u1' stays first and stays Alice so activePeerId (set by mount's
// own store.setState above) still points at a real dialog.
const pickerDialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 400, topMessageId: 3, readOutboxMaxId: 0, preview: null },
  { peerId: 'u2', title: 'Nguyễn Tấn Phát', pinned: 0, unreadCount: 0, lastMessageAt: 300, topMessageId: 1, readOutboxMaxId: 0, preview: null },
  { peerId: 'u3', title: 'Em Việt Tú', pinned: 0, unreadCount: 0, lastMessageAt: 200, topMessageId: 1, readOutboxMaxId: 0, preview: null },
  { peerId: 'u4', title: 'Nga Trần', pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 1, readOutboxMaxId: 0, preview: null },
];

test('<C-p> opens the chat picker', async () => {
  const { renderer, store } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  expect(store.getState().overlay).toBe('chatpicker');
  // "Jump to chat" is the picker's own prompt -- unlike a dialog title, it
  // can never appear for any other reason (the sidebar, say), so it is safe
  // to look for in the whole frame rather than one row of it.
  expect(renderer.captureCharFrame()).toContain('Jump to chat');
});

test('escape closes the chat picker without opening anything or changing the active chat', async () => {
  const { renderer, store, opened } = await mount({ dialogs: pickerDialogs });
  expect(store.getState().activePeerId).toBe('u1');

  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('duc'); });
  await renderer.flush();

  await pressEscape(renderer);
  expect(store.getState().overlay).toBeNull();
  expect(store.getState().activePeerId).toBe('u1');
  expect(opened).toEqual([]);
});

// The headline case task-8-brief.md names directly: typing narrows the list,
// and it does so with a plain ASCII query against a diacritic candidate --
// "nguyen" is not in "Nguyễn Tấn Phát" as a literal substring at all, only as
// a fold of it -- proving the wiring end to end, not just fuzzy-match.ts alone.
test('typing "nguyen" narrows the list to Nguyễn Tấn Phát, and Enter opens it', async () => {
  const { renderer, store, opened } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('nguyen'); });
  await renderer.flush();
  expect(store.getState().chatPickerQuery).toBe('nguyen');

  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(opened).toEqual(['u2']);
  expect(store.getState().overlay).toBeNull();
  expect(store.getState().engine.context).toBe(VimContexts.MESSAGES);
  // Mirrors "return in the chat list opens the chat" -- jumping via the
  // picker moves the chat list's own cursor to match, exactly as opening the
  // same chat by navigating to it with j/k and Enter would.
  expect(store.getState().chatCursor).toBe(1);
});

test('backspace in the chat picker removes the last typed character', async () => {
  const { renderer, store } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('ducx'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressBackspace(); });
  await renderer.flush();
  expect(store.getState().chatPickerQuery).toBe('duc');
});

test('j clamps the selection at the last result rather than running past it', async () => {
  const { renderer, store } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  await act(async () => {
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('j');
  });
  await renderer.flush();
  expect(store.getState().chatPickerCursor).toBe(pickerDialogs.length - 1);
});

test('k clamps the selection at zero rather than going negative', async () => {
  const { renderer, store } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('k'); });
  await renderer.flush();
  expect(store.getState().chatPickerCursor).toBe(0);
});

test('j (or <C-n>) moves the selection down, and Enter opens the newly selected chat', async () => {
  const { renderer, opened } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  // No query typed: every dialog is a match, in original order (fuzzyMatch's
  // own empty-query rule), so pickerDialogs[0] (Alice) starts selected and one
  // step down lands on pickerDialogs[1].
  await act(async () => { renderer.mockInput.pressKey('n', { ctrl: true }); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(opened).toEqual(['u2']);
});

// <C-p> is overloaded: from outside the picker it opens it, but the brief
// gives it a second job once the picker owns input -- move the selection up,
// the same as k -- so it must never also close the overlay it is already
// inside, or the key would be self-defeating the moment the picker needs it
// for anything past the first result.
test('<C-p> moves the selection back up rather than closing the picker it just opened', async () => {
  const { renderer, opened, store } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  await act(async () => {
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('j');
  });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  expect(store.getState().overlay).toBe('chatpicker');

  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(opened).toEqual(['u2']);
});

// The load-bearing guard, the same one which-key's own "j does not move the
// message cursor" test and the delete confirmation's "j does not move the
// cursor" test both already cover for their own overlays: a stray key must
// not reach the pane underneath.
test('while the chat picker is open, j does not move the message cursor', async () => {
  const { renderer, store } = await mount({ dialogs: pickerDialogs });
  expect(store.getState().messageCursor).toBe(0);

  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();

  expect(store.getState().messageCursor).toBe(0);
});

// The other half of the same guard: 'i' is ordinarily a mode switch
// (VimModes.INSERT), so this also proves typed letters become query text
// while the picker is open rather than falling through to the engine.
test('while the chat picker is open, i does not enter insert mode -- it types into the query', async () => {
  const { renderer, store } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();

  expect(store.getState().engine.mode).toBe('normal');
  expect(store.getState().chatPickerQuery).toBe('i');
});

// Mirrors "starting a reply shrinks..." and the which-key overlay's own
// implicit budget: Composer is not rendered at all while the picker is open,
// so if chromeHeight had not grown to match ChatPicker's own rows, the status
// line would be pushed off its row instead of failing loudly.
test('opening the chat picker shrinks the message pane so the status line stays on its own row, uncorrupted', async () => {
  const { renderer, store } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  const rows = renderer.captureCharFrame().split('\n');
  expect(rows[TERMINAL_HEIGHT - 1]).toContain('NORMAL');
  expect(rows[TERMINAL_HEIGHT - 1]).toContain(`1/${store.getState().messages.length}`);
});

// --- M1b-2 Task 9: `/`, n, N -- search the open chat's cached messages ------
//
// Unlike the chat picker, SearchOverlay has no results list of its own to
// render: Enter jumps straight to the first match and n/N (once the overlay
// has closed) step through the rest, exactly the way vim's own `/` behaves
// without 'incsearch'. mount()'s own database is seeded with exactly this
// fixture (both as state.messages and as real cache rows), since
// MessageSearchService reads the cache, not state.messages directly.
const searchFixtureMessages: IMessageRow[] = [
  { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'morning stand-up at 9', out: 0, entities: [], replyToMessageId: null },
  { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'lunch plans?', out: 0, entities: [], replyToMessageId: null },
  { peerId: 'u1', id: 3, fromId: 'u1', date: 300, text: 'another stand-up tomorrow', out: 0, entities: [], replyToMessageId: null },
  { peerId: 'u1', id: 4, fromId: 'u1', date: 400, text: 'see you then', out: 0, entities: [], replyToMessageId: null },
];

test('/ opens the search overlay', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  expect(store.getState().overlay).toBe('search');
  expect(renderer.captureCharFrame()).toContain('Search: ');
});

test('typing narrows the query, shown live on the overlay', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('stand'); });
  await renderer.flush();
  expect(store.getState().searchQuery).toBe('stand');
  expect(renderer.captureCharFrame()).toContain('Search: stand');
});

test('backspace in the search overlay removes the last typed character', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('standx'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressBackspace(); });
  await renderer.flush();
  expect(store.getState().searchQuery).toBe('stand');
});

// "stand-up" appears in messages 1 and 3 (state.messages indices 0 and 2,
// oldest-first) -- the first is index 0, the topmost/earliest one currently
// loaded, not whichever the DB happens to return first.
test('Enter jumps the message cursor to the first match and closes the overlay', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('stand'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(store.getState().overlay).toBeNull();
  expect(store.getState().messageCursor).toBe(0);
});

// MessageView only highlights the cursor row while focused
// (message-view.tsx) -- `/` is context '*', reachable from the chat list the
// same way `\` and <C-p> are, so without this a jump triggered from there
// would move messageCursor with nothing on screen to show it moved.
test('Enter focuses the messages pane, so a jump triggered from the chat list is visible', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('n'); renderer.mockInput.pressKey('f'); });
  await renderer.flush();
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);

  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('stand'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();

  expect(store.getState().engine.context).toBe(VimContexts.MESSAGES);
  expect(store.getState().messageCursor).toBe(0);
});

// Mirrors the chat picker's own precedent (Enter with nothing selected is a
// no-op, overlay stays open) -- there is nothing to jump to yet, which reads
// as "keep refining the query", not as "give up and close".
test('Enter with no matches does nothing -- the overlay stays open and the cursor does not move', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('nonexistent'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(store.getState().overlay).toBe('search');
  expect(store.getState().messageCursor).toBe(0);
});

// The load-bearing guard, the same one which-key's and the chat picker's own
// "j does not move the message cursor" tests already cover for their overlays.
test('while the search overlay is open, j does not move the message cursor', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  expect(store.getState().messageCursor).toBe(0);

  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();

  expect(store.getState().messageCursor).toBe(0);
});

// The other half of the same guard: 'i' is ordinarily a mode switch
// (VimModes.INSERT), so this also proves typed letters become query text
// while the overlay is open rather than falling through to the engine --
// mirrors the identical chat-picker test above.
test('while the search overlay is open, i does not enter insert mode -- it types into the query', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();

  expect(store.getState().engine.mode).toBe('normal');
  expect(store.getState().searchQuery).toBe('i');
});

test('escape closes the search overlay and restores the cursor to where it was', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('j'); renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(2);

  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('lunch'); });
  await renderer.flush();

  await pressEscape(renderer);
  expect(store.getState().overlay).toBeNull();
  expect(store.getState().messageCursor).toBe(2);
  expect(store.getState().searchQuery).toBe('');
});

// The rigorous version of the test just above: nothing the *search overlay's
// own* key handling does can ever move messageCursor while it is open (every
// key is swallowed), so a version of app.tsx that simply left messageCursor
// out of the escape patch entirely -- never reading searchCursorBeforeOpen at
// all -- would pass that test too, for the wrong reason. This one forces a
// real difference between "what messageCursor is right now" and "what it was
// when `/` opened" by writing to the store directly, the way an unrelated
// event (a live message arriving elsewhere, say) could -- proving escape
// truly restores the captured snapshot, not merely whatever is current.
test('escape restores the snapshot taken at open time, not whatever the cursor became afterward', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(1);

  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  expect(store.getState().searchCursorBeforeOpen).toBe(1);

  // Simulates something outside the search overlay's own keyboard handling
  // moving the cursor while it is open -- not reachable through a key press,
  // since the overlay swallows every one, but a real possibility from, say,
  // a live update landing mid-search. Wrapped in act() like every state
  // change here: this still triggers App's own re-render.
  await act(async () => { store.setState({ patch: { messageCursor: 3 } }); });
  await renderer.flush();

  await pressEscape(renderer);
  expect(store.getState().messageCursor).toBe(1);
});

// The snapshot (searchCursorBeforeOpen) is captured fresh on every open, not
// carried over from an earlier search session -- proven by actually moving
// the cursor via a real match first (Enter), then opening a second,
// uncommitted search and escaping it: the cursor must land back where the
// FIRST search left it, not at the position from before that search ever ran.
test('escape after a second search restores to where the cursor was before THAT search opened, not further back', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('lunch'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(1);

  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('anything'); });
  await renderer.flush();
  await pressEscape(renderer);

  expect(store.getState().messageCursor).toBe(1);
});

// <S-n> shares no prefix with `nf` (keymap.test.ts already pins this at the
// engine level), so it resolves with no ambiguity and needs no timeout wait,
// unlike bare `n` below.
test('N (shift-n) cycles backward through the committed matches, wrapping to the last one', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('stand'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(0);

  await act(async () => { renderer.mockInput.pressKey('n', { shift: true }); });
  await renderer.flush();
  // The two "stand-up" matches sit at indices 0 and 2; backward from 0 wraps to 2.
  expect(store.getState().messageCursor).toBe(2);
});

// Bare `n` is genuinely ambiguous against `nf` (keymap.test.ts), so it needs
// App's own timeoutlen to settle before it resolves as SEARCH_CYCLE -- the
// same wait Task 2's own ambiguous-key tests already rely on.
test('n alone, once the ambiguity against nf times out, cycles forward through the committed matches', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('stand'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(0);

  await act(async () => { renderer.mockInput.pressKey('n'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(0); // still ambiguous, waiting on the timer

  await act(async () => { await new Promise(resolve => { setTimeout(resolve, AMBIGUOUS_KEY_SETTLE_MILLISECONDS); }); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(2);
});

// The regression this task's own brief called out by name: giving `n` a real
// binding must not break `nf`, typed at ordinary speed, from resolving
// exactly as it always did -- both keys land inside one synchronous burst
// here, well under timeoutMilliseconds, so the ambiguity never gets the
// chance to settle on its own before the second key completes `nf`.
test('nf still focuses the chat list when typed quickly, even though n now has its own binding', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => {
    renderer.mockInput.pressKey('n');
    renderer.mockInput.pressKey('f');
  });
  await renderer.flush();
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);
  // Confirms the ambiguity did not also fire SEARCH_CYCLE on the way --
  // there was no committed search, so an errant cycle would still have left
  // messageCursor at 0, but a non-zero count of registered matches would
  // have caught it; asserting on the pure absence of a search having run is
  // simpler and just as conclusive.
  expect(store.getState().searchMatchIds).toEqual([]);
});

// The owner's own chat list is mostly Vietnamese (task-8-brief.md) -- proven
// here end to end (cache -> MessageSearchService -> App -> cursor), not only
// at the database layer (database.test.ts).
test('/ finds a real Vietnamese message end-to-end', async () => {
  const vietnameseMessages: IMessageRow[] = [
    { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'Chào buổi sáng', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'Hẹn gặp lại nhé', out: 0, entities: [], replyToMessageId: null },
  ];
  const { renderer, store } = await mount({ messages: vietnameseMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('Hẹn'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(store.getState().overlay).toBeNull();
  expect(store.getState().messageCursor).toBe(1);
});

// Mirrors "starting a reply shrinks..." and the chat picker's own chromeHeight
// regression test: Composer is not rendered at all while the search overlay
// is open, so if chromeHeight had not grown to match SearchOverlay's own two
// rows, the status line would be pushed off its row instead of failing loudly.
test('opening the search overlay shrinks the message pane so the status line stays on its own row, uncorrupted', async () => {
  const { renderer, store } = await mount({ messages: searchFixtureMessages });
  await act(async () => { renderer.mockInput.pressKey('/'); });
  await renderer.flush();
  const rows = renderer.captureCharFrame().split('\n');
  expect(rows[TERMINAL_HEIGHT - 1]).toContain('NORMAL');
  expect(rows[TERMINAL_HEIGHT - 1]).toContain(`1/${store.getState().messages.length}`);
});

// "typing…" belongs in the chat header, where every graphical client puts it.
test('the open chat header says what the other side is doing', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    store.setState({ patch: {
      typingByPeer: new Map([['u1', { actorId: 'u1', phrase: 'choosing a sticker', expiresAt: Date.now() + 5_000 }]]),
    } });
  });
  await renderer.flush();
  expect(renderer.captureCharFrame().split('\n')[0]!).toContain('choosing a sticker');
});

// A status whose expiry has passed must not be drawn even if nothing cleared
// it -- a suspended laptop is exactly the case where the timer fires late.
test('an expired typing status is not drawn', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    store.setState({ patch: {
      typingByPeer: new Map([['u1', { actorId: 'u1', phrase: 'typing…', expiresAt: Date.now() - 1 }]]),
    } });
  });
  await renderer.flush();
  const top = renderer.captureCharFrame().split('\n')[0]!;
  expect(top).not.toContain('typing');
  expect(top).toContain('Alice');
});

// ── the mouse ─────────────────────────────────────────────────────────────
//
// M2's governing rule is that the mouse is an alternative route, never the
// only one -- so every one of these has a keyboard equivalent already tested
// above, and each asserts the click produces the same outcome that key does.

test('clicking a chat focuses the chat list and opens it, the way Enter does', async () => {
  const { renderer, store, opened } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  // Row 1 is the first chat's name row: row 0 is the frame's top edge, and
  // column 1 is inside the sidebar past the frame's left border.
  await act(async () => { await mouse.click(2, 1); });
  await renderer.flush();

  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);
  expect(opened).toEqual(['u1']);
});

// Clicking the preview line means the same chat as clicking its name: both
// rows are one target, because they are one chat.
test('clicking a chat preview row opens the same chat as its name row', async () => {
  const { renderer, opened } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(2, 2); });
  await renderer.flush();

  expect(opened).toEqual(['u1']);
});

test('clicking a message focuses the messages pane and moves the cursor there', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('n'); renderer.mockInput.pressKey('f'); });
  await renderer.flush();
  expect(store.getState().engine.context).toBe(VimContexts.CHAT_LIST);

  const mouse = createMockMouse(renderer.renderer);
  // The third message's row, inside the right pane.
  await act(async () => { await mouse.click(40, 3); });
  await renderer.flush();

  expect(store.getState().engine.context).toBe(VimContexts.MESSAGES);
  expect(store.getState().messageCursor).toBe(2);
});

// A click must never reach past the end of the list: the pane draws blank rows
// below the last message, and a click on one of those has no message to mean.
test('clicking a blank row below the last message leaves the cursor alone', async () => {
  const { renderer, store } = await mount();
  const before = store.getState().messageCursor;
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 9); });
  await renderer.flush();

  expect(store.getState().messageCursor).toBe(before);
});

// The one rule the whole milestone is governed by, checked rather than
// asserted in prose: a right click must not act as a left one. Until the
// context menu exists it does nothing at all -- but it must not open a chat.
test('a right click does not open a chat', async () => {
  const { renderer, opened } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(2, 1, MouseButtons.RIGHT); });
  await renderer.flush();

  expect(opened).toEqual([]);
});

/**
 * Enough chats that the cursor has somewhere to scroll to. `u1` stays first
 * because mount seeds its peers from this list, and its default messages
 * belong to u1 -- dropping it fails the foreign key from messages to peers.
 */
const manyDialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 0, lastMessageAt: 1000, topMessageId: 1, readOutboxMaxId: 0, preview: null },
  ...Array.from({ length: 11 }, (unused, index) => ({
    peerId: `s${String(index)}`,
    title: `chat${String(index)}`,
    pinned: 0,
    unreadCount: 0,
    lastMessageAt: 999 - index,
    topMessageId: 1,
    readOutboxMaxId: 0,
    preview: null,
  })),
];

test('the wheel scrolls the conversation', async () => {
  const { renderer, store } = await mount();
  const mouse = createMockMouse(renderer.renderer);
  expect(store.getState().messageCursor).toBe(0);

  await act(async () => { await mouse.scroll(40, 3, 'down'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBeGreaterThan(0);

  await act(async () => { await mouse.scroll(40, 3, 'up'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(0);
});

test('the wheel scrolls the chat list', async () => {
  const { renderer, store } = await mount({ dialogs: manyDialogs });
  const mouse = createMockMouse(renderer.renderer);
  expect(store.getState().chatCursor).toBe(0);

  await act(async () => { await mouse.scroll(2, 2, 'down'); });
  await renderer.flush();

  expect(store.getState().chatCursor).toBeGreaterThan(0);
});

// Scrolling the sidebar moves through chats; it must never open one. That is
// the rule that reading is an explicit act, in the one place a wheel could
// break it.
test('scrolling the chat list opens nothing', async () => {
  const { renderer, opened } = await mount({ dialogs: manyDialogs });
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.scroll(2, 2, 'down'); });
  await act(async () => { await mouse.scroll(2, 2, 'down'); });
  await renderer.flush();

  expect(opened).toEqual([]);
});

// A wheel at the end of the list must stop, not wrap round to the top.
test('the wheel stops at the ends rather than wrapping', async () => {
  const { renderer, store } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  for (let notch = 0; notch < 6; notch += 1) {
    await act(async () => { await mouse.scroll(40, 3, 'up'); });
  }
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(0);

  for (let notch = 0; notch < 12; notch += 1) {
    await act(async () => { await mouse.scroll(40, 3, 'down'); });
  }
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(store.getState().messages.length - 1);
});

// Reported: "sometimes the conversation pane has no vertical line". Pressing
// the leader was enough -- which-key grows with the number of bindings, and on
// a short terminal it asked for nearly the whole window, leaving the frame as
// a top edge, one row and a bottom edge. The borders had not gone anywhere;
// there was nothing left between them.
test('an overlay never squeezes the panes down to nothing', async () => {
  for (const keys of [['\\'], ['<C-p>'], ['/']]) {
    const { renderer } = await mount();
    await act(async () => {
      for (const key of keys) {
        if (key === '<C-p>') {
          renderer.mockInput.pressKey('p', { ctrl: true });
        } else {
          renderer.mockInput.pressKey(key);
        }
      }
    });
    await renderer.flush();

    const rows = renderer.captureCharFrame().split('\n').filter(row => row !== '');
    const framed = rows.filter(row => '┌└│'.includes(row[0] ?? ''));
    // Top edge, bottom edge and at least the minimum in between.
    expect({ keys: keys.join(''), framed: framed.length >= 6 }).toEqual({ keys: keys.join(''), framed: true });
  }
});

// Every framed row closes on the right. A row that opened with a border and
// ended without one would mean content had overdrawn it.
test('every framed row closes on the right, at every size', async () => {
  for (const [width, height] of [[70, 14], [60, 12], [46, 10], [40, 10], [34, 9]] as Array<[number, number]>) {
    const { renderer } = await mount({ width, height });
    const rows = renderer.captureCharFrame().split('\n').filter(row => row !== '');
    const unclosed = rows
      .filter(row => '┌└│'.includes(row[0] ?? ''))
      .filter(row => !'┐┘│'.includes(row[row.length - 1] ?? ''));
    expect({ width, unclosed: unclosed.length }).toEqual({ width, unclosed: 0 });
  }
});

// ── drags ─────────────────────────────────────────────────────────────────

test('dragging the divider rebalances the panes', async () => {
  const { renderer } = await mount({ width: 90, height: 14 });
  const before = renderer.captureCharFrame().split('\n')[0]!.indexOf('┬');
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.drag(before, 4, before + 10, 4); });
  await renderer.flush();

  const after = renderer.captureCharFrame().split('\n')[0]!.indexOf('┬');
  expect(after).toBeGreaterThan(before);
});

// resolvePaneWidths owns the minimum, and the drag must not be able to talk it
// past that -- a divider dragged to the far edge would otherwise leave a pane
// with nothing in it.
test('the divider cannot be dragged far enough to erase a pane', async () => {
  const { renderer } = await mount({ width: 90, height: 14 });
  const mouse = createMockMouse(renderer.renderer);
  const start = renderer.captureCharFrame().split('\n')[0]!.indexOf('┬');

  await act(async () => { await mouse.drag(start, 4, 89, 4); });
  await renderer.flush();

  const rows = renderer.captureCharFrame().split('\n').filter(row => row !== '');
  const junction = rows[0]!.indexOf('┬');
  expect(junction).toBeGreaterThan(0);
  expect(junction).toBeLessThan(89 - 1);
  // And the frame still closes: nothing was squeezed into a negative width.
  const unclosed = rows
    .filter(row => '┌└│'.includes(row[0] ?? ''))
    .filter(row => !'┐┘│'.includes(row[row.length - 1] ?? ''));
  expect(unclosed).toHaveLength(0);
});


// ── the right-click menu ──────────────────────────────────────────────────

test('right-clicking a message opens a menu at the pointer', async () => {
  const { renderer, store } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 3, MouseButtons.RIGHT); });
  await renderer.flush();

  expect(store.getState().contextMenu?.kind).toBe('message');
  expect(renderer.captureCharFrame()).toContain('Reply');
});

// A menu about a message must leave the cursor on that message, or choosing
// Delete would ask about one while the cursorline sat on another.
test('the menu moves the cursor to the message it is about', async () => {
  const { renderer, store } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 3, MouseButtons.RIGHT); });
  await renderer.flush();

  expect(store.getState().messageCursor).toBe(2);
});

// Edit is offered only where `e` would actually work. Telegram refuses to edit
// someone else's message, and so does EDIT_START.
//
// Own and theirs are seeded explicitly: mount's default history is entirely
// incoming, so a test relying on one of those rows being own would assert
// nothing. The first version of this did exactly that and read the correct
// absence of Edit as a bug.
test('edit is offered on your own message and withheld on theirs', async () => {
  const mixed: IMessageRow[] = [
    { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'theirs', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 2, fromId: 'me', date: 200, text: 'mine', out: 1, entities: [], replyToMessageId: null },
  ];
  const { renderer } = await mount({ messages: mixed });
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 1, MouseButtons.RIGHT); });
  await renderer.flush();
  expect(renderer.captureCharFrame()).not.toContain('Edit');

  await pressEscape(renderer);
  await act(async () => { await mouse.click(40, 2, MouseButtons.RIGHT); });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('Edit');
});

// M2's governing rule, in the feature that introduces the mouse: a menu you
// could not operate from the keyboard would be the first mouse-only thing.
test('the menu is navigable by j, k and Enter', async () => {
  const { renderer, store } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 3, MouseButtons.RIGHT); });
  await renderer.flush();
  expect(store.getState().contextMenu?.cursor).toBe(0);

  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().contextMenu?.cursor).toBe(1);

  await act(async () => { renderer.mockInput.pressKey('k'); });
  await renderer.flush();
  expect(store.getState().contextMenu?.cursor).toBe(0);

  // Enter on Reply, the first item.
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(store.getState().contextMenu).toBeNull();
  expect(store.getState().replyToMessageId).not.toBeNull();
});

test('escape closes the menu without doing anything', async () => {
  const { renderer, store, deleted } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 3, MouseButtons.RIGHT); });
  await renderer.flush();
  await pressEscape(renderer);
  await renderer.flush();

  expect(store.getState().contextMenu).toBeNull();
  expect(store.getState().replyToMessageId).toBeNull();
  expect(deleted).toEqual([]);
});

// The menu must not become the one route that skips the only confirmation in
// the app: Delete goes through DELETE_REQUEST exactly as `dd` does.
test('choosing Delete still asks y/n rather than deleting outright', async () => {
  const { renderer, store, deleted } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 3, MouseButtons.RIGHT); });
  await renderer.flush();

  const items = store.getState().contextMenu;
  expect(items).not.toBeNull();
  // Walk to Delete, which is last.
  for (let step = 0; step < 6; step += 1) {
    await act(async () => { renderer.mockInput.pressKey('j'); });
  }
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();

  expect(deleted).toEqual([]);
  expect(store.getState().pendingConfirmation).not.toBeNull();
  expect(renderer.captureCharFrame()).toContain('Delete this message?');
});

// A key that means something in the pane underneath must not reach it while
// the menu is open, or it would act on a message the menu is asking about.
test('keys do not fall through the menu to the pane underneath', async () => {
  const { renderer, store } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 3, MouseButtons.RIGHT); });
  await renderer.flush();
  const before = store.getState().composerText;

  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();

  expect(store.getState().engine.mode).toBe(VimModes.NORMAL);
  expect(store.getState().composerText).toBe(before);
});

test('right-clicking a chat offers to open it', async () => {
  const { renderer, store } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(2, 1, MouseButtons.RIGHT); });
  await renderer.flush();

  expect(store.getState().contextMenu?.kind).toBe('chat');
  expect(renderer.captureCharFrame()).toContain('Open');
});

// Drag-to-scroll was built and then removed at the owner's request. A drag
// anywhere but the divider must now do nothing at all -- and in particular
// must not still move the cursor, which is what it used to do.
test('dragging inside the conversation no longer scrolls it', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('g'); renderer.mockInput.pressKey('g'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(0);

  const mouse = createMockMouse(renderer.renderer);
  // The press itself is a click and moves the cursor to that message; the
  // movement after it must add nothing.
  await act(async () => { await mouse.pressDown(40, 2); });
  await renderer.flush();
  const afterPress = store.getState().messageCursor;

  await act(async () => { await mouse.moveTo(40, 8); });
  await act(async () => { await mouse.release(40, 8); });
  await renderer.flush();

  expect(store.getState().messageCursor).toBe(afterPress);
});

// ── display toggles ───────────────────────────────────────────────────────

test('zt hides the clock and gives its columns to the conversation', async () => {
  const { renderer, store } = await mount({ width: 74, height: 8 });
  const rowAt = (index: number): string => renderer.captureCharFrame().split('\n')[index]!;
  // Sliced at the junction: the sidebar carries its own clock on the same
  // terminal row, and the first version of this test matched that instead --
  // reading a working feature as broken.
  const conversationOn = (index: number): string => {
    const row = rowAt(index);
    return row.slice(rowAt(0).indexOf('┬'));
  };
  const contentStart = (): number => conversationOn(1).indexOf('msg1');
  const before = contentStart();

  await act(async () => { renderer.mockInput.pressKey('z'); renderer.mockInput.pressKey('t'); });
  await renderer.flush();

  expect(store.getState().showTime).toBe(false);
  expect(conversationOn(1)).not.toMatch(/\d\d:\d\d/);
  // The text moved left rather than a hole being left where the clock was.
  expect(contentStart()).toBeLessThan(before);
});

test('zn hides the gutter and gives its columns to the conversation', async () => {
  const { renderer, store } = await mount({ width: 74, height: 8 });
  const contentStart = (): number => renderer.captureCharFrame().split('\n')[1]!.indexOf('msg1');
  const before = contentStart();

  await act(async () => { renderer.mockInput.pressKey('z'); renderer.mockInput.pressKey('n'); });
  await renderer.flush();

  expect(store.getState().showGutter).toBe(false);
  expect(contentStart()).toBeLessThan(before);
});

test('both toggles are switches, not one-way', async () => {
  const { renderer, store } = await mount();

  for (const [key, field] of [['t', 'showTime'], ['n', 'showGutter']] as Array<[string, 'showTime' | 'showGutter']>) {
    await act(async () => { renderer.mockInput.pressKey('z'); renderer.mockInput.pressKey(key); });
    await renderer.flush();
    expect(store.getState()[field], `${key} off`).toBe(false);

    await act(async () => { renderer.mockInput.pressKey('z'); renderer.mockInput.pressKey(key); });
    await renderer.flush();
    expect(store.getState()[field], `${key} on`).toBe(true);
  }
});

// zs already lived under the same prefix; adding two more must not have made
// any of the three ambiguous with another.
test('zs still reveals a spoiler alongside the new z bindings', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('z'); renderer.mockInput.pressKey('s'); });
  await renderer.flush();
  expect(store.getState().revealedSpoilers.size).toBeGreaterThan(0);
});

// Reported: the menu stayed open after clicking away. Only escape and choosing
// an item closed it, which is not what any menu does.
test('clicking away closes the context menu', async () => {
  const { renderer, store } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 3, MouseButtons.RIGHT); });
  await renderer.flush();
  expect(store.getState().contextMenu).not.toBeNull();

  await act(async () => { await mouse.click(40, 8); });
  await renderer.flush();

  expect(store.getState().contextMenu).toBeNull();
});

// The guard that makes the above safe: children handle a press before the root
// does, so a right click has already opened its menu by the time the root sees
// the same press. Closing unconditionally would shut it before it was drawn.
test('a right click still opens a menu despite click-away closing', async () => {
  const { renderer, store } = await mount();
  const mouse = createMockMouse(renderer.renderer);

  await act(async () => { await mouse.click(40, 3, MouseButtons.RIGHT); });
  await renderer.flush();
  expect(store.getState().contextMenu).not.toBeNull();

  // And a second right click, with one already open, retargets rather than
  // closing and leaving nothing.
  await act(async () => { await mouse.click(40, 2, MouseButtons.RIGHT); });
  await renderer.flush();
  expect(store.getState().contextMenu).not.toBeNull();
});
