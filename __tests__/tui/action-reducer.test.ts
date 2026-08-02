import { test, expect } from 'bun:test';

// Concrete module, not the core/ barrel -- see src/tui/action-reducer.ts for why.
import { ApplicationStoreService, type IApplicationState } from '../../src/core/application-store.ts';
import { ActionTypes, VimContexts, VimModes } from '../../src/keys/common/index.ts';
import { applyAction } from '../../src/tui/action-reducer.ts';

const buildState = (patch: Partial<IApplicationState> = {}): IApplicationState => {
  const store = new ApplicationStoreService();
  store.setState({
    patch: {
      messages: [1, 2, 3, 4].map(id => ({
        peerId: 'u1', id, fromId: 'u1', date: id * 100, text: `m${id}`, out: 0, entities: [], replyToMessageId: null,
      })),
      ...patch,
    },
  });
  return store.getState();
};

test('cursor.move advances the message cursor', () => {
  const patch = applyAction({
    state: buildState({ messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 1 },
  });
  expect(patch.messageCursor).toBe(1);
});

test('cursor.move honours a count', () => {
  const patch = applyAction({
    state: buildState({ messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 3 },
  });
  expect(patch.messageCursor).toBe(3);
});

test('the message cursor clamps at both ends', () => {
  expect(applyAction({
    state: buildState({ messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: -5 },
  }).messageCursor).toBe(0);
  expect(applyAction({
    state: buildState({ messageCursor: 3 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 9 },
  }).messageCursor).toBe(3);
});

test('cursor.edge jumps to first and last', () => {
  expect(applyAction({
    state: buildState({ messageCursor: 2 }),
    action: { type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' },
  }).messageCursor).toBe(0);
  expect(applyAction({
    state: buildState({ messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'last' },
  }).messageCursor).toBe(3);
});

test('moving with no messages stays at zero', () => {
  expect(applyAction({
    state: buildState({ messages: [], messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 1 },
  }).messageCursor).toBe(0);
});

test('composer text is appended and removed', () => {
  expect(applyAction({
    state: buildState({ composerText: 'on my ' }),
    action: { type: ActionTypes.COMPOSER_INSERT_TEXT, text: 'way' },
  }).composerText).toBe('on my way');
  expect(applyAction({
    state: buildState({ composerText: 'hix' }),
    action: { type: ActionTypes.COMPOSER_BACKSPACE },
  }).composerText).toBe('hi');
});

test('backspace on empty text is harmless', () => {
  expect(applyAction({
    state: buildState({ composerText: '' }),
    action: { type: ActionTypes.COMPOSER_BACKSPACE },
  }).composerText).toBe('');
});

test('spoiler.reveal adds the message under the cursor', () => {
  const state = buildState({ messageCursor: 1 });
  const patch = applyAction({ state, action: { type: ActionTypes.SPOILER_REVEAL } });
  expect([...patch.revealedSpoilers!]).toEqual([state.messages[1]!.id]);
});

// Guards two failure modes at once: a naive `set.has(id) ? set : ...` shortcut
// that returns the same reference when the id is already present would pass
// the contents check below but still break useSyncExternalStore, which bails
// out on an unchanged reference -- so identity is asserted unconditionally,
// not just when the content actually changes.
test('revealing twice keeps one entry and does not throw', () => {
  const state = buildState({ messageCursor: 0, revealedSpoilers: new Set([1]) });
  const patch = applyAction({ state, action: { type: ActionTypes.SPOILER_REVEAL } });
  expect([...patch.revealedSpoilers!]).toEqual([1]);
  expect(patch.revealedSpoilers).not.toBe(state.revealedSpoilers);
});

// Reveals accumulate per message id rather than replacing whatever was
// revealed before -- without this, revealing a second spoiler would silently
// re-mask the first one the next time its row rendered.
test('revealing a second message keeps the first one revealed', () => {
  const state = buildState({ messageCursor: 1, revealedSpoilers: new Set([1]) });
  const patch = applyAction({ state, action: { type: ActionTypes.SPOILER_REVEAL } });
  expect([...patch.revealedSpoilers!].sort()).toEqual([1, 2]);
});

test('revealing with no messages is harmless', () => {
  const state = buildState({ messages: [], messageCursor: 0 });
  expect(() => applyAction({ state, action: { type: ActionTypes.SPOILER_REVEAL } })).not.toThrow();
});

test('reply.start targets the message under the cursor', () => {
  const state = buildState({ messageCursor: 2 });
  const patch = applyAction({ state, action: { type: ActionTypes.REPLY_START } });
  expect(patch.replyToMessageId).toBe(state.messages[2]!.id);
});

test('reply.start with no messages is harmless', () => {
  const state = buildState({ messages: [], messageCursor: 0 });
  expect(() => applyAction({ state, action: { type: ActionTypes.REPLY_START } })).not.toThrow();
  expect(applyAction({ state, action: { type: ActionTypes.REPLY_START } })).toEqual({});
});

test('reply.cancel clears the reply target', () => {
  const state = buildState({ replyToMessageId: 3 });
  const patch = applyAction({ state, action: { type: ActionTypes.REPLY_CANCEL } });
  expect(patch.replyToMessageId).toBeNull();
});

test('edit.start loads the composer with the message under the cursor, when it is your own', () => {
  const state = buildState({
    messageCursor: 0,
    messages: [{ peerId: 'u1', id: 9, fromId: 'me', date: 900, text: 'own message', out: 1, entities: [], replyToMessageId: null }],
    composerText: 'draft',
  });
  const patch = applyAction({ state, action: { type: ActionTypes.EDIT_START } });
  expect(patch.editingMessageId).toBe(9);
  expect(patch.composerText).toBe('own message');
  expect(patch.composerTextBeforeEdit).toBe('draft');
  expect(patch.engine?.mode).toBe(VimModes.INSERT);
  expect(patch.engine?.context).toBe(VimContexts.COMPOSER);
});

// The default buildState() fixture is out: 0 throughout -- not the user's own.
test('edit.start refuses a message that is not your own, and says so', () => {
  const state = buildState({ messageCursor: 0 });
  const patch = applyAction({ state, action: { type: ActionTypes.EDIT_START } });
  expect(patch.editingMessageId).toBeUndefined();
  expect(patch.composerText).toBeUndefined();
  expect(patch.engine).toBeUndefined();
  expect(patch.statusMessage).toBeTruthy();
});

test('edit.start with no messages is harmless', () => {
  const state = buildState({ messages: [], messageCursor: 0 });
  expect(() => applyAction({ state, action: { type: ActionTypes.EDIT_START } })).not.toThrow();
  expect(applyAction({ state, action: { type: ActionTypes.EDIT_START } })).toEqual({});
});

test('edit.cancel restores the composer to what it held before the edit began', () => {
  const state = buildState({ editingMessageId: 9, composerText: 'own message, edited', composerTextBeforeEdit: 'draft' });
  const patch = applyAction({ state, action: { type: ActionTypes.EDIT_CANCEL } });
  expect(patch.editingMessageId).toBeNull();
  expect(patch.composerText).toBe('draft');
  expect(patch.composerTextBeforeEdit).toBeNull();
});

test('delete.request asks for confirmation on the message under the cursor', () => {
  const state = buildState({ messageCursor: 2 });
  const patch = applyAction({ state, action: { type: ActionTypes.DELETE_REQUEST } });
  expect(patch.pendingConfirmation).toEqual({ kind: 'delete', messageId: state.messages[2]!.id });
  expect(patch.statusMessage).toBeTruthy();
});

test('delete.request with no messages is harmless', () => {
  const state = buildState({ messages: [], messageCursor: 0 });
  expect(() => applyAction({ state, action: { type: ActionTypes.DELETE_REQUEST } })).not.toThrow();
  expect(applyAction({ state, action: { type: ActionTypes.DELETE_REQUEST } })).toEqual({});
});

test('confirmation.confirm clears the pending confirmation and the prompt', () => {
  const state = buildState({
    pendingConfirmation: { kind: 'delete', messageId: 3 },
    statusMessage: 'Delete this message? (y/n)',
  });
  const patch = applyAction({ state, action: { type: ActionTypes.CONFIRM } });
  expect(patch.pendingConfirmation).toBeNull();
  expect(patch.statusMessage).toBeNull();
});

// Cancelling clears the same two fields CONFIRM does -- only the side effect
// (App calling onDelete) tells the two apart, and that lives in app.tsx, not here.
test('confirmation.cancel clears the pending confirmation and the prompt', () => {
  const state = buildState({
    pendingConfirmation: { kind: 'delete', messageId: 3 },
    statusMessage: 'Delete this message? (y/n)',
  });
  const patch = applyAction({ state, action: { type: ActionTypes.CANCEL_CONFIRMATION } });
  expect(patch.pendingConfirmation).toBeNull();
  expect(patch.statusMessage).toBeNull();
});

test('an unknown action type is rejected rather than ignored', () => {
  expect(() =>
    applyAction({ state: buildState(), action: { type: 'nonsense' } as never }),
  ).toThrow(/\[applyAction\]/);
});
