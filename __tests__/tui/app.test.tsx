import { test, expect } from 'bun:test';
import { act } from 'react';

import { BindingScopes, Container } from '@venizia/ignis-inversion';
import { rgbToHex } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import { BindingKeys } from '../../src/common/index.ts';
// Concrete module, not the core/ barrel -- see src/tui/action-reducer.ts for why.
import { ApplicationStoreService } from '../../src/core/application-store.ts';
import type { IDialogRow, IMessageRow } from '../../src/core/cache/index.ts';
import { VimContexts } from '../../src/keys/common/index.ts';
import { KeyNormalizerService, KeymapService, VimEngineService } from '../../src/keys/index.ts';
import { renderWithKeys } from '../helpers/render.tsx';
import { buildTokens } from '../../src/tui/theme/index.ts';
import { App } from '../../src/tui/app.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

// Mirrors the layout constants in src/tui/app.tsx.
const TERMINAL_WIDTH = 70;
const TERMINAL_HEIGHT = 14;
const SIDEBAR_WIDTH = 22;
const CHROME_HEIGHT = 3;

const dialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 3 },
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

const pressEscape = async (renderer: TestRendererSetup): Promise<void> => {
  await act(async () => {
    renderer.mockInput.pressEscape();
    await new Promise(resolve => { setTimeout(resolve, ESCAPE_FLUSH_MILLISECONDS); });
  });
  await renderer.flush();
};

const mount = async (opts: { messages?: IMessageRow[]; onSend?: (text: string) => Promise<void> } = {}) => {
  const container = new Container({ scope: 'AppTest' });
  container.bind({ key: BindingKeys.KEY_NORMALIZER }).toClass(KeyNormalizerService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.VIM_ENGINE }).toClass(VimEngineService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.KEYMAP }).toClass(KeymapService).setScope(BindingScopes.SINGLETON);

  const store = new ApplicationStoreService();
  store.setState({
    patch: { dialogs, messages: opts.messages ?? messages, activePeerId: 'u1', connection: 'connected' },
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

  const renderer = await renderWithKeys(
    <App
      store={store}
      engine={container.get<VimEngineService>({ key: BindingKeys.VIM_ENGINE })}
      keymapService={container.get<KeymapService>({ key: BindingKeys.KEYMAP })}
      keyNormalizer={container.get<KeyNormalizerService>({ key: BindingKeys.KEY_NORMALIZER })}
      tokens={tokens}
      resolveSenderName={() => 'Alice'}
      onSend={onSend}
      onQuit={() => { quit.push(true); }}
      onOpenChat={async chat => { opened.push(chat.peerId); }}
    />,
    { width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT },
  );
  await renderer.flush();
  return { renderer, store, sent, composerAtSend, opened, quit };
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
