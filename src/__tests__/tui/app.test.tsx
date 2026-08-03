import { test, expect } from 'bun:test';
import { act } from 'react';

import { BindingScopes, Container } from '@venizia/ignis-inversion';
import { rgbToHex } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import { BindingKeys } from '../../common/index.ts';
// Concrete module, not the core/ barrel -- see src/tui/action-reducer.ts for why.
import { ApplicationStoreService } from '../../core/application-store.ts';
import type { IDialogRow, IMessageRow } from '../../core/cache/index.ts';
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
const CHROME_HEIGHT = 3;

const dialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 3, readOutboxMaxId: 0 },
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
  onDelete?: (deletion: { messageId: number }) => Promise<void>;
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

  const store = new ApplicationStoreService();
  store.setState({
    patch: {
      dialogs: opts.dialogs ?? dialogs,
      messages: opts.messages ?? messages,
      activePeerId: 'u1',
      connection: 'connected',
    },
  });

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
  const deleted: Array<{ messageId: number }> = [];
  const onDelete = opts.onDelete ?? (async (deletion: { messageId: number }): Promise<void> => {
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
      onSend={onSend}
      onEdit={onEdit}
      onDelete={onDelete}
      onQuit={() => { quit.push(true); }}
      onOpenChat={onOpenChat}
      onMarkRead={onMarkRead}
    />,
    { width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT },
  );
  await renderer.flush();
  return { renderer, store, sent, composerAtSend, edited, deleted, opened, marked, quit };
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

// The seam between two bordered boxes drew a doubled `┐┌`, and the owner's own
// fillchars call for a single rule instead. The composer's box went the same
// way, which is also what freed the row the panes now use.
test('the panes are separated by one rule, with no boxes anywhere', async () => {
  const { renderer } = await mount();
  const rows = renderer.captureCharFrame().split('\n');
  const body = rows.slice(0, TERMINAL_HEIGHT - CHROME_HEIGHT);

  for (const row of body) {
    expect({ row, rule: row[SIDEBAR_WIDTH] }).toEqual({ row, rule: '│' });
  }
  expect(rows[TERMINAL_HEIGHT - CHROME_HEIGHT]).toBe('─'.repeat(TERMINAL_WIDTH));

  const frame = renderer.captureCharFrame();
  for (const glyph of ['┌', '┐', '└', '┘', '├', '┤', '┬', '┴']) {
    expect({ glyph, present: frame.includes(glyph) }).toEqual({ glyph, present: false });
  }
});

test('the open chat is marked in the sidebar independently of the cursor', async () => {
  const { renderer } = await mount();
  expect(renderer.captureCharFrame().split('\n')[0]![0]).toBe('▎');
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
  expect(deleted).toEqual([{ messageId: 1 }]);

  await act(async () => { renderer.mockInput.pressKey('.'); });
  await renderer.flush();
  expect(deleted).toEqual([{ messageId: 1 }]); // not yet a second delete
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
  expect(store.getState().pendingConfirmation).toEqual({ kind: 'delete', messageId: 1 });
  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();

  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(1);

  await act(async () => { renderer.mockInput.pressKey('.'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).toEqual({ kind: 'delete', messageId: 2 });

  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(deleted).toEqual([{ messageId: 1 }, { messageId: 2 }]);
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
  expect(store.getState().pendingConfirmation).toEqual({ kind: 'delete', messageId: 1 });
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
  expect(deleted).toEqual([{ messageId: 1 }]);
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

// --- M1b-2 Task 8: <C-p>, fuzzy jump to any chat -----------------------------
//
// The owner's own chat list is mostly Vietnamese (task-8-brief.md) -- this
// fixture mirrors that, rather than an all-ASCII stand-in, so the tests below
// exercise the actual reason the feature exists, not just wiring in the
// abstract. 'u1' stays first and stays Alice so activePeerId (set by mount's
// own store.setState above) still points at a real dialog.
const pickerDialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 400, topMessageId: 3, readOutboxMaxId: 0 },
  { peerId: 'u2', title: 'Đức anh hoàng', pinned: 0, unreadCount: 0, lastMessageAt: 300, topMessageId: 1, readOutboxMaxId: 0 },
  { peerId: 'u3', title: 'Em Việt Tú', pinned: 0, unreadCount: 0, lastMessageAt: 200, topMessageId: 1, readOutboxMaxId: 0 },
  { peerId: 'u4', title: 'Nga Trần', pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 1, readOutboxMaxId: 0 },
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
// "duc" is not in "Đức anh hoàng" as a literal substring at all, only as a
// fold of it -- proving the wiring end to end, not just fuzzy-match.ts alone.
test('typing "duc" narrows the list to Đức anh hoàng, and Enter opens it', async () => {
  const { renderer, store, opened } = await mount({ dialogs: pickerDialogs });
  await act(async () => { renderer.mockInput.pressKey('p', { ctrl: true }); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('duc'); });
  await renderer.flush();
  expect(store.getState().chatPickerQuery).toBe('duc');

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
