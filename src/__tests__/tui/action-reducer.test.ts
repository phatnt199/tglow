import { test, expect } from 'bun:test';

// Concrete module, not the core/ barrel -- see src/tui/action-reducer.ts for why.
import { ApplicationStoreService, type IApplicationState } from '../../core/application-store.ts';
import { ActionTypes, INITIAL_ENGINE_STATE, Operators, VimContexts, VimModes } from '../../keys/common/index.ts';
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
  expect(patch.pendingConfirmation?.kind).toBe('delete');
  expect(patch.statusMessage).toBeTruthy();
});

// Through M1b-2 this deliberately confirmed one message however wide the
// range, so `3dd` asked about one and deleted one. The range is honoured now:
// the confirmation names every message it is about to delete, and answering it
// once deletes all of them.
test('operator.apply delete over a multi-message range confirms the whole range', () => {
  const state = buildState({ messageCursor: 0 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 2 },
  });
  expect(patch.pendingConfirmation).toEqual({
    kind: 'delete',
    messageIds: state.messages.slice(0, 3).map(message => message.id),
  });
});

// Counting is what the prompt is for: answering "Delete this message?" and
// losing three would be the worst version of this feature.
test('the confirmation says how many messages it is about to delete', () => {
  const state = buildState({ messageCursor: 0 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 2 },
  });
  expect(patch.statusMessage).toBe('Delete 3 messages? (y/n)');
});

// A single message keeps the wording it has always had -- "Delete 1 message?"
// reads like a machine, and this is the overwhelmingly common case.
test('a single-message delete still asks the singular question', () => {
  const state = buildState({ messageCursor: 0 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 0 },
  });
  expect(patch.statusMessage).toBe('Delete this message? (y/n)');
  expect(patch.pendingConfirmation).toEqual({ kind: 'delete', messageIds: [state.messages[0]!.id] });
});

// `3dd` on the second-to-last message asks for three and can only have two.
// vim deletes what is there rather than refusing, and the prompt has to say
// two, or it is lying about what y will do.
test('a range running past the last message is clamped, and the prompt counts what is really there', () => {
  const state = buildState({ messageCursor: 2 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 9 },
  });
  expect(patch.pendingConfirmation).toEqual({
    kind: 'delete',
    messageIds: state.messages.slice(2).map(message => message.id),
  });
  expect(patch.statusMessage).toBe('Delete 2 messages? (y/n)');
});

// M1b-2 Task 5, decision 1: unlike Task 4's deliberate no-op, delete now
// also writes the targeted message into a register -- real vim's own
// unnamed register captures a delete exactly as it captures a yank, and
// leaving tglow's dd the one operator that never populated any register
// would silently break the single most common reason a vim user reaches for
// dd at all: dd then (Task 6+) p to move a message.
test('operator.apply delete also writes the targeted message into the default register', () => {
  const state = buildState({ messageCursor: 2 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 0 },
  });
  expect(patch.registers).toEqual({ '"': state.messages[2]!.text });
});

// The register takes the whole range, joined the way yank joins one -- vim's
// `3dd` puts three lines in the unnamed register, not the first of them.
test('a ranged delete registers every message it deletes, joined like a ranged yank', () => {
  const state = buildState({ messageCursor: 0 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 2 },
  });
  expect(patch.registers).toEqual({
    '"': state.messages.slice(0, 3).map(message => message.text).join('\n'),
  });
});

test('operator.apply delete writes into the named register when one is pending, not just the default', () => {
  const state = buildState({ messageCursor: 0, engine: { ...INITIAL_ENGINE_STATE, register: 'a' } });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 0 },
  });
  expect(patch.registers).toEqual({ a: state.messages[0]!.text });
});

test('operator.apply delete with no messages does not touch the register', () => {
  const state = buildState({ messages: [], messageCursor: 0 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 0 },
  });
  expect(patch.registers).toBeUndefined();
});

// yy with no register named (M1b-2 Task 5): writes UNNAMED_REGISTER, vim's
// own name for the unnamed register -- exactly what an unprefixed yy always
// did before named registers existed, just under a different key.
test('operator.apply yank with no register named copies into the default register', () => {
  const state = buildState({ messageCursor: 1 });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 0 },
  });
  expect(patch.registers).toEqual({ '"': state.messages[1]!.text });
  expect(patch.statusMessage).toBeTruthy();
});

test('operator.apply yank writes into the named register when one is pending', () => {
  const state = buildState({ messageCursor: 1, engine: { ...INITIAL_ENGINE_STATE, register: 'a' } });
  const patch = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 0 },
  });
  expect(patch.registers).toEqual({ a: state.messages[1]!.text });
});

// The brief's own test list: "ayy then "byy keeps both -- proven here at the
// store, not just the engine field (vim-engine.test.ts's own version proves
// the field; this proves what actually lands in the map).
test('yanking into a then b keeps both registers, not just the last one', () => {
  const afterA = applyAction({
    state: buildState({ messageCursor: 0, engine: { ...INITIAL_ENGINE_STATE, register: 'a' } }),
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 0 },
  });
  const state = buildState({
    messageCursor: 1,
    registers: afterA.registers,
    engine: { ...INITIAL_ENGINE_STATE, register: 'b' },
  });
  const afterB = applyAction({
    state,
    action: { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 0 },
  });
  expect(afterB.registers).toEqual({ a: 'm1', b: 'm2' });
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
  expect(patch.registers).toEqual({ '"': `${state.messages[0]!.text}\n${state.messages[1]!.text}` });
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

// M1b-2 Task 5: the status line's only sign a register was even named --
// naming one moves no cursor and changes no mode, so without this it would
// look exactly like a dead key, the same class of bug yy's own status
// message and <S-k>'s "no link" message already exist to avoid.
test('register.set surfaces the register name rather than looking like a no-op', () => {
  const patch = applyAction({ state: buildState(), action: { type: ActionTypes.REGISTER_SET, name: 'a' } });
  expect(patch.statusMessage).toBeTruthy();
  expect(patch.statusMessage).toContain('a');
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
  expect(patch.pendingConfirmation).toEqual({ kind: 'delete', messageIds: [state.messages[2]!.id] });
  expect(patch.statusMessage).toBeTruthy();
});

test('delete.request with no messages is harmless', () => {
  const state = buildState({ messages: [], messageCursor: 0 });
  expect(() => applyAction({ state, action: { type: ActionTypes.DELETE_REQUEST } })).not.toThrow();
  expect(applyAction({ state, action: { type: ActionTypes.DELETE_REQUEST } })).toEqual({});
});

test('confirmation.confirm clears the pending confirmation and the prompt', () => {
  const state = buildState({
    pendingConfirmation: { kind: 'delete', messageIds: [3] },
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
    pendingConfirmation: { kind: 'delete', messageIds: [3] },
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

// M1b-2 Task 9: overlay.toggle into 'search' captures the cursor position so
// the search overlay's own <escape> (app.tsx) can restore it later -- the
// same "snapshot before, restore on cancel" shape composerTextBeforeEdit
// already uses for edit.start/edit.cancel.
test("overlay.toggle into 'search' captures the current message cursor", () => {
  const state = buildState({ messageCursor: 2, overlay: null });
  const patch = applyAction({ state, action: { type: ActionTypes.OVERLAY_TOGGLE, overlay: 'search' } });
  expect(patch.overlay).toBe('search');
  expect(patch.searchCursorBeforeOpen).toBe(2);
});

// searchQuery resets alongside chatPickerQuery/chatPickerCursor, whichever
// overlay opens or closes -- harmless for whichkey/chatpicker, which never
// read it, the same reasoning those two already carry for each other.
test('overlay.toggle resets a stale search query regardless of which overlay it opens', () => {
  const state = buildState({ searchQuery: 'stale query', overlay: null });
  const patch = applyAction({ state, action: { type: ActionTypes.OVERLAY_TOGGLE, overlay: 'whichkey' } });
  expect(patch.searchQuery).toBe('');
});

// M1b-2 Task 9: n/N. searchMatchIds are message ids, not array positions --
// set once by app.tsx's own Enter-commit, then re-resolved to a *current*
// index here on every cycle, so a message that moved or vanished since the
// search was committed is dropped rather than pointing the cursor at the
// wrong row (or crashing). buildState()'s own fixture is ids 1-4 at indices
// 0-3, oldest first, exactly like the real oldest-first state.messages.
test('search.cycle next moves the cursor to the next match after it', () => {
  const state = buildState({ messageCursor: 0, searchMatchIds: [2, 4] });
  const patch = applyAction({ state, action: { type: ActionTypes.SEARCH_CYCLE, direction: 'next' } });
  expect(patch.messageCursor).toBe(1);
});

test('search.cycle next skips past a match the cursor already sits on, rather than re-selecting it', () => {
  const state = buildState({ messageCursor: 1, searchMatchIds: [2, 4] });
  const patch = applyAction({ state, action: { type: ActionTypes.SEARCH_CYCLE, direction: 'next' } });
  expect(patch.messageCursor).toBe(3);
});

test('search.cycle next wraps around to the first match once past the last one', () => {
  const state = buildState({ messageCursor: 3, searchMatchIds: [2, 4] });
  const patch = applyAction({ state, action: { type: ActionTypes.SEARCH_CYCLE, direction: 'next' } });
  expect(patch.messageCursor).toBe(1);
});

test('search.cycle previous moves the cursor to the nearest match before it', () => {
  const state = buildState({ messageCursor: 3, searchMatchIds: [1, 3] });
  const patch = applyAction({ state, action: { type: ActionTypes.SEARCH_CYCLE, direction: 'previous' } });
  expect(patch.messageCursor).toBe(2);
});

test('search.cycle previous wraps around to the last match once before the first one', () => {
  const state = buildState({ messageCursor: 0, searchMatchIds: [1, 3] });
  const patch = applyAction({ state, action: { type: ActionTypes.SEARCH_CYCLE, direction: 'previous' } });
  expect(patch.messageCursor).toBe(2);
});

test('search.cycle is a no-op when there is no committed search', () => {
  const state = buildState({ messageCursor: 1, searchMatchIds: [] });
  const patch = applyAction({ state, action: { type: ActionTypes.SEARCH_CYCLE, direction: 'next' } });
  expect(patch).toEqual({});
});

// A matched id can outlive its own position: a message deleted after the
// search was committed drops out of state.messages entirely (deleteMessage
// flags it; listMessages, and every republish that follows, excludes it).
test('search.cycle skips a matched id no longer present in state.messages', () => {
  const state = buildState({ messageCursor: 0, searchMatchIds: [99, 3] });
  const patch = applyAction({ state, action: { type: ActionTypes.SEARCH_CYCLE, direction: 'next' } });
  expect(patch.messageCursor).toBe(2);
});

// ── conversation panes ────────────────────────────────────────────────────
//
// The arrangement under test: the focused pane's conversation lives in the
// flat state, and only moves into its grid slot when the focus leaves. These
// are the moments that swap, and getting one wrong shows a pane someone else's
// messages.

const ROOMY: Partial<IApplicationState> = { conversationWidth: 400, conversationHeight: 100 };

/**
 * A split leaves the focus in the chat list, waiting for the chat the new pane
 * is for. These tests are about moving between panes, which happens once that
 * choice is made -- so they stand where Enter or Escape would have left them.
 */
const inMessages: Partial<IApplicationState> = {
  engine: { ...INITIAL_ENGINE_STATE, context: VimContexts.MESSAGES },
};

test('a vertical split opens a column on the same conversation and focuses it', () => {
  const patch = applyAction({
    state: buildState({ ...ROOMY, activePeerId: 'u1', messageCursor: 2 }),
    action: { type: ActionTypes.PANE_SPLIT, direction: 'vertical' },
  });

  expect(patch.paneGrid).toHaveLength(2);
  expect(patch.activePane).toEqual({ column: 1, row: 0 });
  // The conversation on screen is already the new pane's, so it is left alone.
  expect(patch.messages).toBeUndefined();
  // And the focus goes where the next decision is: which chat this pane is
  // for. A second view of the same conversation is not the reason to split a
  // chat client, so the gesture does not stop half way there.
  expect(patch.engine!.context).toBe(VimContexts.CHAT_LIST);
});

test('a horizontal split stacks a row inside the column it was called from', () => {
  const patch = applyAction({
    state: buildState({ ...ROOMY, activePeerId: 'u1' }),
    action: { type: ActionTypes.PANE_SPLIT, direction: 'horizontal' },
  });

  expect(patch.paneGrid).toHaveLength(1);
  expect(patch.paneGrid![0]).toHaveLength(2);
  expect(patch.activePane).toEqual({ column: 0, row: 1 });
});

test('a split with no room says which way it could not go', () => {
  expect(applyAction({
    state: buildState({ conversationWidth: 50, conversationHeight: 100 }),
    action: { type: ActionTypes.PANE_SPLIT, direction: 'vertical' },
  }).statusMessage).toBe('No room for another column');

  expect(applyAction({
    state: buildState({ conversationWidth: 400, conversationHeight: 6 }),
    action: { type: ActionTypes.PANE_SPLIT, direction: 'horizontal' },
  }).statusMessage).toBe('No room for another row');
});

// The one that matters: moving between panes has to carry each conversation
// with it, or the pane you left keeps drawing the messages you took with you.
test('moving to another pane swaps the conversations over', () => {
  const split = applyAction({
    state: buildState({ ...ROOMY, activePeerId: 'u1', messageCursor: 3 }),
    action: { type: ActionTypes.PANE_SPLIT, direction: 'vertical' },
  });
  // The right-hand pane is now looking at a different chat.
  const twoChats = buildState({
    ...ROOMY,
    ...split,
    ...inMessages,
    activePeerId: 'u2',
    messages: [{ peerId: 'u2', id: 9, fromId: 'u2', date: 900, text: 'from the other chat', out: 0, entities: [], replyToMessageId: null }],
    messageCursor: 0,
  } as Partial<IApplicationState>);

  const back = applyAction({ state: twoChats, action: { type: ActionTypes.PANE_FOCUS, direction: 'left' } });

  expect(back.activePane).toEqual({ column: 0, row: 0 });
  // The left pane's own conversation comes back to the flat state...
  expect(back.activePeerId).toBe('u1');
  expect(back.messageCursor).toBe(3);
  // ...and the one that was on screen is safely in the pane just left.
  expect(back.paneGrid![1]![0]!.peerId).toBe('u2');
  expect(back.paneGrid![1]![0]!.messages).toHaveLength(1);
});

test('up and down move between stacked conversations', () => {
  const split = applyAction({
    state: buildState({ ...ROOMY, activePeerId: 'u1' }),
    action: { type: ActionTypes.PANE_SPLIT, direction: 'horizontal' },
  });
  const stacked = buildState({ ...ROOMY, ...split, ...inMessages, activePeerId: 'u2' } as Partial<IApplicationState>);

  const up = applyAction({ state: stacked, action: { type: ActionTypes.PANE_FOCUS, direction: 'up' } });
  expect(up.activePane).toEqual({ column: 0, row: 0 });
  expect(up.activePeerId).toBe('u1');
});

test('a draft stays with the pane it was typed in', () => {
  const split = applyAction({
    state: buildState({ ...ROOMY, activePeerId: 'u1' }),
    action: { type: ActionTypes.PANE_SPLIT, direction: 'vertical' },
  });
  const typed = buildState({ ...ROOMY, ...split, ...inMessages, composerText: 'half a sentence' } as Partial<IApplicationState>);

  const left = applyAction({ state: typed, action: { type: ActionTypes.PANE_FOCUS, direction: 'left' } });
  expect(left.composerText).toBe('');

  const right = applyAction({
    state: buildState({ ...ROOMY, ...left, ...inMessages } as Partial<IApplicationState>),
    action: { type: ActionTypes.PANE_FOCUS, direction: 'right' },
  });
  expect(right.composerText).toBe('half a sentence');
});

// <C-w>h kept its old meaning at the left edge, which is the whole reason the
// direction keys stop rather than wrap.
test('left from the leftmost column still lands in the chat list', () => {
  const patch = applyAction({
    state: buildState({ engine: { ...INITIAL_ENGINE_STATE, context: VimContexts.MESSAGES } }),
    action: { type: ActionTypes.PANE_FOCUS, direction: 'left' },
  });

  expect(patch.engine!.context).toBe(VimContexts.CHAT_LIST);
  expect(patch.activePane).toBeUndefined();
});

test('right from the chat list goes back to the conversation, not to another pane', () => {
  const patch = applyAction({
    state: buildState({ engine: { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST } }),
    action: { type: ActionTypes.PANE_FOCUS, direction: 'right' },
  });

  expect(patch.engine!.context).toBe(VimContexts.MESSAGES);
  expect(patch.activePane).toBeUndefined();
});

// The chat list has its own j and k, so up and down must not steal them.
test('up and down do nothing while the chat list has the focus', () => {
  for (const direction of ['up', 'down'] as const) {
    expect(applyAction({
      state: buildState({ engine: { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST } }),
      action: { type: ActionTypes.PANE_FOCUS, direction },
    })).toEqual({});
  }
});

// <C-w>w cycles among conversations the way it cycles among windows in vim --
// it never falls out into the sidebar.
test('cycling wraps between panes without visiting the chat list', () => {
  const split = applyAction({
    state: buildState({ ...ROOMY, activePeerId: 'u1' }),
    action: { type: ActionTypes.PANE_SPLIT, direction: 'vertical' },
  });
  const wrapped = applyAction({
    state: buildState({ ...ROOMY, ...split, ...inMessages } as Partial<IApplicationState>),
    action: { type: ActionTypes.PANE_CYCLE, delta: 1 },
  });

  expect(wrapped.activePane).toEqual({ column: 0, row: 0 });
  expect(wrapped.engine!.context).toBe(VimContexts.MESSAGES);
});

test('closing a pane hands the focus and the conversation to its neighbour', () => {
  const split = applyAction({
    state: buildState({ ...ROOMY, activePeerId: 'u1', messageCursor: 2 }),
    action: { type: ActionTypes.PANE_SPLIT, direction: 'vertical' },
  });
  const closed = applyAction({
    state: buildState({ ...ROOMY, ...split, activePeerId: 'u2' } as Partial<IApplicationState>),
    action: { type: ActionTypes.PANE_CLOSE },
  });

  expect(closed.paneGrid).toHaveLength(1);
  expect(closed.activePane).toEqual({ column: 0, row: 0 });
  expect(closed.activePeerId).toBe('u1');
  expect(closed.messageCursor).toBe(2);
});

test('the last pane refuses to close, and says why', () => {
  const patch = applyAction({ state: buildState(), action: { type: ActionTypes.PANE_CLOSE } });

  expect(patch.paneGrid).toBeUndefined();
  expect(patch.statusMessage).toBe('The last conversation pane stays open');
});
