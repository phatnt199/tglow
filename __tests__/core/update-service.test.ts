import { test, expect } from 'bun:test';

import { ApplicationStoreService } from '../../src/core/application-store.ts';
import { DatabaseService, type IMessageRow } from '../../src/core/cache/index.ts';
import type { IMessageAdapter, IRawMessage } from '../../src/core/message-service.ts';
import { buildMessageAdapter } from '../../src/core/telegram-adapter.ts';
import { UpdateService } from '../../src/core/update-service.ts';

const buildRawMessage = (overrides: Partial<IRawMessage> = {}): IRawMessage => ({
  id: 1, peerId: 'u1', fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null, ...overrides,
});

const buildRow = (overrides: Partial<IMessageRow> = {}): IMessageRow => ({
  peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null, ...overrides,
});

/** A fake IMessageAdapter that lets a test fire a "live" message on demand, exactly like DialogService/MessageService's own adapter fakes but with a subscription to drive instead of a promise to resolve. */
const buildAdapter = (): { adapter: IMessageAdapter; emit: (message: IRawMessage) => void } => {
  let onMessage: ((message: IRawMessage) => void) | null = null;
  const adapter: IMessageAdapter = {
    fetchHistory: async () => [],
    send: async opts => buildRawMessage({ peerId: opts.peerId, text: opts.text }),
    edit: async opts => buildRawMessage({ id: opts.messageId, peerId: opts.peerId, text: opts.text }),
    subscribeToNewMessages: subscribeOpts => {
      onMessage = subscribeOpts.onMessage;
      return (): void => {
        onMessage = null;
      };
    },
  };
  return { adapter, emit: (message: IRawMessage): void => onMessage?.(message) };
};

const buildService = (
  adapter: IMessageAdapter,
): { service: UpdateService; database: DatabaseService; store: ApplicationStoreService } => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h1', title: 'Alice', username: null });
  database.upsertPeer({ id: 'u2', type: 'user', accessHash: 'h2', title: 'Bob', username: null });
  const store = new ApplicationStoreService();
  return { service: new UpdateService(adapter, database, store), database, store };
};

test('a message for the active chat appears in the store messages', () => {
  const { adapter, emit } = buildAdapter();
  const { service, store, database } = buildService(adapter);
  store.setState({ patch: { activePeerId: 'u1', messages: [], messageCursor: 0 } });
  service.start();

  emit(buildRawMessage({ id: 1, peerId: 'u1', text: 'hello there' }));

  expect(store.getState().messages.map(message => message.text)).toEqual(['hello there']);
  database.close();
});

test('a message for a different chat is cached and refreshes the dialog list, but does not appear in messages', () => {
  const { adapter, emit } = buildAdapter();
  const { service, store, database } = buildService(adapter);
  store.setState({ patch: { activePeerId: 'u1', messages: [] } });
  service.start();

  emit(buildRawMessage({ id: 1, peerId: 'u2', text: 'for someone else' }));

  expect(store.getState().messages).toEqual([]);
  expect(store.getState().dialogs.find(dialog => dialog.peerId === 'u2')?.unreadCount).toBe(1);
  database.close();
});

test('the message is written to the cache in both the active-chat and different-chat cases', () => {
  const { adapter, emit } = buildAdapter();
  const { service, database } = buildService(adapter);
  service.start();

  emit(buildRawMessage({ id: 1, peerId: 'u1', text: 'active chat' }));
  emit(buildRawMessage({ id: 2, peerId: 'u2', text: 'different chat' }));

  expect(database.listMessages({ peerId: 'u1', limit: 50 }).map(row => row.text)).toEqual(['active chat']);
  expect(database.listMessages({ peerId: 'u2', limit: 50 }).map(row => row.text)).toEqual(['different chat']);
  database.close();
});

test('messages stay oldest-first after a live arrival', () => {
  const { adapter, emit } = buildAdapter();
  const { service, store, database } = buildService(adapter);
  const seed = [
    buildRow({ id: 1, date: 100, text: 'first' }),
    buildRow({ id: 2, date: 200, text: 'second' }),
  ];
  database.insertMessages({ messages: seed });
  store.setState({ patch: { activePeerId: 'u1', messages: seed, messageCursor: 1 } });
  service.start();

  emit(buildRawMessage({ id: 3, peerId: 'u1', date: 300, text: 'third' }));

  expect(store.getState().messages.map(message => message.text)).toEqual(['first', 'second', 'third']);
  database.close();
});

test('a message that duplicates one already cached does not appear twice', () => {
  const { adapter, emit } = buildAdapter();
  const { service, store, database } = buildService(adapter);
  const seed = [buildRow({ id: 1, date: 100, text: 'hello' })];
  database.insertMessages({ messages: seed });
  store.setState({ patch: { activePeerId: 'u1', messages: seed, messageCursor: 0 } });
  service.start();

  emit(buildRawMessage({ id: 1, peerId: 'u1', date: 100, text: 'hello' }));

  expect(store.getState().messages).toHaveLength(1);
  expect(database.listMessages({ peerId: 'u1', limit: 50 })).toHaveLength(1);
  database.close();
});

test('the handler swallows and logs an adapter error rather than rethrowing', () => {
  const { adapter, emit } = buildAdapter();
  const { service, database } = buildService(adapter);
  service.start();

  // 'ghost' was never upserted as a peer, so the FK from messages.peerId to
  // peers.id rejects the cache write -- the same failure mode already proven
  // in message-service.test.ts's "reaches Telegram but fails to cache" case,
  // triggered here through the live-update path instead of send().
  expect(() => emit(buildRawMessage({ id: 1, peerId: 'ghost', text: 'boo' }))).not.toThrow();
  database.close();
});

test("start()'s returned function actually unsubscribes", () => {
  const { adapter, emit } = buildAdapter();
  const { service, store, database } = buildService(adapter);
  store.setState({ patch: { activePeerId: 'u1', messages: [] } });
  const stop = service.start();

  stop();
  emit(buildRawMessage({ id: 1, peerId: 'u1', text: 'too late' }));

  expect(store.getState().messages).toEqual([]);
  expect(store.getState().dialogs).toEqual([]);
  database.close();
});

test('a cursor on the newest message follows a live arrival', () => {
  const { adapter, emit } = buildAdapter();
  const { service, store, database } = buildService(adapter);
  const seed = [buildRow({ id: 1, date: 100, text: 'first' }), buildRow({ id: 2, date: 200, text: 'second' })];
  database.insertMessages({ messages: seed });
  // messageCursor 1 is the index of the last element of a 2-message array --
  // the newest message.
  store.setState({ patch: { activePeerId: 'u1', messages: seed, messageCursor: 1 } });
  service.start();

  emit(buildRawMessage({ id: 3, peerId: 'u1', date: 300, text: 'third' }));

  expect(store.getState().messageCursor).toBe(2);
  database.close();
});

test('a cursor reading earlier history stays on the same message after a live arrival', () => {
  const { adapter, emit } = buildAdapter();
  const { service, store, database } = buildService(adapter);
  const seed = [
    buildRow({ id: 1, date: 100, text: 'first' }),
    buildRow({ id: 2, date: 200, text: 'second' }),
    buildRow({ id: 3, date: 300, text: 'third' }),
  ];
  database.insertMessages({ messages: seed });
  // messageCursor 0 is the oldest message, not the newest -- reading back
  // through history rather than tailing it.
  store.setState({ patch: { activePeerId: 'u1', messages: seed, messageCursor: 0 } });
  service.start();

  emit(buildRawMessage({ id: 4, peerId: 'u1', date: 400, text: 'fourth' }));

  expect(store.getState().messageCursor).toBe(0);
  expect(store.getState().messages[0]?.text).toBe('first');
  database.close();
});

// The gap this whole task exists to close: nothing else in the type system
// forces the adapter to expose a subscription. Delete this method from
// buildMessageAdapter (or from IMessageAdapter) and this test -- not just a
// live account -- is what fails.
test('IMessageAdapter exposes subscribeToNewMessages, so removing it cannot silently disable receive', () => {
  const adapter = buildMessageAdapter({ client: {} as any });
  expect(typeof adapter.subscribeToNewMessages).toBe('function');
});
