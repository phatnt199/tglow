import { test, expect } from 'bun:test';

// Concrete module, not the core/ barrel -- see src/tui/action-reducer.ts for why.
import { ApplicationStoreService, type IApplicationState } from '../../core/application-store.ts';
import { ActionTypes, Operators, VimContexts, VimModes } from '../../keys/common/index.ts';
import { applyAction } from '../../tui/action-reducer.ts';

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

// M1b-2 Task 4: OPERATOR_APPLY now does something per operator. Delete
// routes through delete.request's own logic -- confirmation, not an
// outright delete -- so `dd`/`3dd`/`d3j` all still gate on the same y/n
// prompt M1b-1 built, whatever range named them. Routed through applyAction
// recursively rather than a duplicated patch, so a later change to the
// prompt or the refusal can never drift between the two paths.
test('operator.apply delete asks for confirmation, the same way delete.request does, whatever the range', () => {
  const state = buildState({ messageCursor: 2 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 2 },
  });
  expect(patch.pendingConfirmation).toEqual({ kind: 'delete', messageId: state.messages[2]!.id });
  expect(patch.statusMessage).toBeTruthy();
});

// The range's own extent is not consulted for delete: only the message at
// the cursor is ever named in the confirmation. Acting on the full range
// would mean confirming and deleting more than one message from a single
// y/n answer -- a bigger, deliberately deferred feature (a pendingConfirmation
// shape that names several messages, and a loop in App's CONFIRM handling),
// not a side effect doubling itself asks for. This is what keeps `3dd`
// honest: it confirms, but confirming deletes one message, not three.
test('operator.apply delete over a multi-message range still only confirms the one at the cursor', () => {
  const state = buildState({ messageCursor: 0 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 2 },
  });
  expect(patch.pendingConfirmation).toEqual({ kind: 'delete', messageId: state.messages[0]!.id });
});

// yy: registers land in Task 5 (a named `"`-prefixed map on the store); this
// is the single unnamed slot Task 5 builds on rather than around -- every
// yank overwrites it, matching vim's own unnamed register.
test('operator.apply yank copies the message under the cursor into the single yank slot', () => {
  const state = buildState({ messageCursor: 1 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 0 },
  });
  expect(patch.yankedText).toBe(state.messages[1]!.text);
  expect(patch.statusMessage).toBeTruthy();
});

// Unlike delete, yank is not destructive, so there is no confirmation to
// simplify around -- the full range is honoured, joined the way vim joins a
// multi-line yank into one register value. Proves count multiplies the
// doubled form correctly one layer below vim-engine.ts's own range tests:
// two messages come back, not four and not one.
test('operator.apply yank over a range joins every targeted message, cursor down through the range', () => {
  const state = buildState({ messageCursor: 0 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 1 },
  });
  expect(patch.yankedText).toBe(`${state.messages[0]!.text}\n${state.messages[1]!.text}`);
});

test('operator.apply yank with no messages is harmless', () => {
  const state = buildState({ messages: [], messageCursor: 0 });
  expect(() => applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 0 },
  })).not.toThrow();
  expect(applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 0 },
  })).toEqual({});
});

// cc: vim's change is delete-then-insert; the message equivalent already
// exists as edit.start, refusal included, so change routes through it the
// same way delete routes through delete.request -- not a copy of its logic.
test('operator.apply change starts editing the message under the cursor, the same way edit.start does', () => {
  const state = buildState({
    messageCursor: 0,
    messages: [{ peerId: 'u1', id: 9, fromId: 'me', date: 900, text: 'own message', out: 1, entities: [], replyToMessageId: null }],
  });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.CHANGE, unit: 'message', from: 0, to: 0 },
  });
  expect(patch.editingMessageId).toBe(9);
  expect(patch.engine?.mode).toBe(VimModes.INSERT);
});

test('operator.apply change refuses a message that is not your own, the same way edit.start does', () => {
  const state = buildState({ messageCursor: 0 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.CHANGE, unit: 'message', from: 0, to: 0 },
  });
  expect(patch.editingMessageId).toBeUndefined();
  expect(patch.statusMessage).toBeTruthy();
});

test('operator.apply rejects an operator from outside the type system', () => {
  expect(() =>
    applyAction({
      state: buildState(),
      action: { type: ActionTypes.OPERATOR_APPLY, operator: 'nonsense', unit: 'message', from: 0, to: 0 } as never,
    }),
  ).toThrow(/\[applyAction\]/);
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

/**
 * Final review, Important 2. composerTextBeforeEdit was captured
 * unconditionally, so a second `e` while an edit was already in progress
 * overwrote the draft with the first message's own text -- and the <escape>
 * that cancels then "restored" that instead of the draft. `e` `jk` `e`
 * `<escape>` destroyed exactly the thing this field exists to protect.
 */
test('a second edit.start does not overwrite the draft the first one saved', () => {
  const state = buildState({
    messageCursor: 0,
    messages: [{ peerId: 'u1', id: 9, fromId: 'me', date: 900, text: 'own message', out: 1, entities: [], replyToMessageId: null }],
    editingMessageId: 9,
    composerText: 'own message',
    composerTextBeforeEdit: 'draft',
  });
  const patch = applyAction({ state, action: { type: ActionTypes.EDIT_START } });
  expect(patch.composerTextBeforeEdit).toBe('draft');
  expect(patch.composerText).toBe('own message');
});

// The whole round trip the bug ran through, so the claim is about what the
// user gets back, not just which field was written.
test('e, then e again, then cancel gives the draft back rather than the message', () => {
  const messages = [
    { peerId: 'u1', id: 9, fromId: 'me', date: 900, text: 'first own', out: 1, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 10, fromId: 'me', date: 910, text: 'second own', out: 1, entities: [], replyToMessageId: null },
  ];
  const start = buildState({ messages, messageCursor: 0, composerText: 'draft' });
  const first = applyAction({ state: start, action: { type: ActionTypes.EDIT_START } });

  const moved = buildState({ ...start, ...first, messages, messageCursor: 1 });
  const second = applyAction({ state: moved, action: { type: ActionTypes.EDIT_START } });

  const cancelled = applyAction({
    state: buildState({ ...moved, ...second, messages }),
    action: { type: ActionTypes.EDIT_CANCEL },
  });
  expect(cancelled.composerText).toBe('draft');
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

// Gap 4b (task-11-report.md): "url, text_url -- the URL shown on K" (spec
// §3.1). K reads the message under the cursor, same as SPOILER_REVEAL and the
// other message-scoped keys above.
test('link.show puts the url in the status line when the message has exactly one link', () => {
  const state = buildState({
    messageCursor: 0,
    messages: [{
      peerId: 'u1', id: 9, fromId: 'u1', date: 900, out: 0, replyToMessageId: null,
      text: 'see docs', entities: [{ kind: 'textUrl', offset: 4, length: 4, url: 'https://example.com' }],
    }],
  });
  const patch = applyAction({ state, action: { type: ActionTypes.LINK_SHOW } });
  expect(patch.statusMessage).toBe('https://example.com');
});

test('link.show says how many more when the message has several links', () => {
  const text = 'first https://a.example second https://b.example';
  const state = buildState({
    messageCursor: 0,
    messages: [{
      peerId: 'u1', id: 9, fromId: 'u1', date: 900, out: 0, replyToMessageId: null,
      text,
      entities: [
        { kind: 'url', offset: 6, length: 17 },
        { kind: 'url', offset: 31, length: 17 },
      ],
    }],
  });
  const patch = applyAction({ state, action: { type: ActionTypes.LINK_SHOW } });
  expect(patch.statusMessage).toBe('https://a.example (+1 more)');
});

// A key that appears to do nothing reads as broken -- silence is not an
// acceptable response to "no link here".
test('link.show says so when the message has no link, rather than staying silent', () => {
  const state = buildState({
    messageCursor: 0,
    messages: [{
      peerId: 'u1', id: 9, fromId: 'u1', date: 900, out: 0, replyToMessageId: null, text: 'no links here', entities: [],
    }],
  });
  const patch = applyAction({ state, action: { type: ActionTypes.LINK_SHOW } });
  expect(patch.statusMessage).toBeTruthy();
  expect(patch.statusMessage).not.toContain('http');
});

test('link.show with no messages is harmless', () => {
  const state = buildState({ messages: [], messageCursor: 0 });
  expect(() => applyAction({ state, action: { type: ActionTypes.LINK_SHOW } })).not.toThrow();
  expect(applyAction({ state, action: { type: ActionTypes.LINK_SHOW } })).toEqual({});
});

test('an unknown action type is rejected rather than ignored', () => {
  expect(() =>
    applyAction({ state: buildState(), action: { type: 'nonsense' } as never }),
  ).toThrow(/\[applyAction\]/);
});

// Final review, Critical 2. integrityWarning is the one status field no
// service patch may clear -- only the user, through this action.
test('warning.dismiss clears the integrity warning', () => {
  const patch = applyAction({
    state: buildState({ integrityWarning: 'some history may be missing' }),
    action: { type: ActionTypes.WARNING_DISMISS },
  });
  expect(patch.integrityWarning).toBeNull();
});

test('warning.dismiss leaves the ordinary status message alone', () => {
  const patch = applyAction({
    state: buildState({ integrityWarning: 'some history may be missing', statusMessage: 'Deleted for you' }),
    action: { type: ActionTypes.WARNING_DISMISS },
  });
  expect(patch.statusMessage).toBeUndefined();
});
