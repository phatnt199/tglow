import { test, expect } from 'bun:test';

// Concrete module, not the core/ barrel -- see src/tui/action-reducer.ts for why.
import { ApplicationStoreService, type IApplicationState } from '../../src/core/application-store.ts';
import { ActionTypes } from '../../src/keys/common/index.ts';
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

test('an unknown action type is rejected rather than ignored', () => {
  expect(() =>
    applyAction({ state: buildState(), action: { type: 'nonsense' } as never }),
  ).toThrow(/\[applyAction\]/);
});
