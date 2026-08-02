import { test, expect } from 'bun:test';

import { ApplicationStoreService } from '../../src/core/application-store.ts';
import { DatabaseService } from '../../src/core/cache/index.ts';
import { MessageService, type IMessageAdapter, type IRawMessage } from '../../src/core/message-service.ts';

const buildRawMessage = (overrides: Partial<IRawMessage> = {}): IRawMessage => ({
  id: 1, peerId: 'u1', fromId: 'u1', date: 100, text: 'hi', out: 0, ...overrides,
});

const buildService = (adapter: IMessageAdapter): { service: MessageService; database: DatabaseService; store: ApplicationStoreService } => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  const store = new ApplicationStoreService();
  return { service: new MessageService(adapter, database, store), database, store };
};

const buildAdapter = (overrides: Partial<IMessageAdapter> = {}): IMessageAdapter => ({
  fetchHistory: async () => [],
  send: async opts => buildRawMessage({ id: 99, peerId: opts.peerId, text: opts.text, out: 1, date: 999 }),
  ...overrides,
});

test('history is presented oldest-first', async () => {
  const { service, store, database } = buildService(
    buildAdapter({
      fetchHistory: async () => [
        buildRawMessage({ id: 1, date: 100, text: 'morning!' }),
        buildRawMessage({ id: 2, date: 200, text: 'ok ping me' }),
      ],
    }),
  );
  await service.loadHistory({ peerId: 'u1', limit: 50 });
  expect(store.getState().messages.map(message => message.text)).toEqual(['morning!', 'ok ping me']);
  database.close();
});

test('history is cached', async () => {
  const { service, database } = buildService(buildAdapter({ fetchHistory: async () => [buildRawMessage()] }));
  await service.loadHistory({ peerId: 'u1', limit: 50 });
  expect(database.listMessages({ peerId: 'u1', limit: 50 })).toHaveLength(1);
  database.close();
});

// The catch path publishes rows straight from the cache; a multi-row case is
// the only one that can tell a correctly-reversed publish from an unreversed
// one -- a single cached row would read the same either way.
test('a network failure falls back to the cache', async () => {
  const { service, store, database } = buildService(
    buildAdapter({ fetchHistory: async () => { throw new Error('offline'); } }),
  );
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'cached first', out: 0 },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'cached second', out: 0 },
    ],
  });
  await service.loadHistory({ peerId: 'u1', limit: 50 });
  expect(store.getState().messages.map(message => message.text)).toEqual(['cached first', 'cached second']);
  expect(store.getState().statusMessage).toContain('offline');
  database.close();
});

// Same reasoning as the catch-path test above: a lone sent message can't
// distinguish a reversed publish from an unreversed one.
test('sending appends the message to the view and clears the composer', async () => {
  const { service, store, database } = buildService(buildAdapter());
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'earlier', out: 0 }],
  });
  store.setState({ patch: { activePeerId: 'u1', composerText: 'on my way' } });
  await service.send({ peerId: 'u1', text: 'on my way' });
  expect(store.getState().messages.map(message => message.text)).toEqual(['earlier', 'on my way']);
  expect(store.getState().composerText).toBe('');
  database.close();
});

test('empty and whitespace-only messages are not sent', async () => {
  let sent = 0;
  const { service, store, database } = buildService(
    buildAdapter({ send: async opts => { sent += 1; return buildRawMessage({ text: opts.text }); } }),
  );
  store.setState({ patch: { composerText: '   ' } });
  await service.send({ peerId: 'u1', text: '   ' });
  expect(sent).toBe(0);
  expect(store.getState().composerText).toBe('   ');
  database.close();
});

// Losing what someone typed is the worst possible failure.
test('a failed send keeps the composed text', async () => {
  const { service, store, database } = buildService(
    buildAdapter({ send: async () => { throw new Error('FLOOD_WAIT_30'); } }),
  );
  store.setState({ patch: { composerText: 'important' } });
  await service.send({ peerId: 'u1', text: 'important' });
  expect(store.getState().composerText).toBe('important');
  expect(store.getState().statusMessage).toContain('FLOOD_WAIT_30');
  database.close();
});

// A hardcoded republish limit would let the visible list grow past whatever
// loadHistory last showed, so messageCursor could point past the end of it.
test('send republishes using the limit from the last loadHistory call', async () => {
  const { service, store, database } = buildService(buildAdapter());
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'earlier', out: 0 }],
  });
  await service.loadHistory({ peerId: 'u1', limit: 1 });
  await service.send({ peerId: 'u1', text: 'on my way' });
  expect(store.getState().messages.map(message => message.text)).toEqual(['on my way']);
  database.close();
});

test('a successful send sets the active peer', async () => {
  const { service, store, database } = buildService(buildAdapter());
  await service.send({ peerId: 'u1', text: 'hello' });
  expect(store.getState().activePeerId).toBe('u1');
  database.close();
});

// The message reached Telegram; only the local copy is missing. Reporting
// this as a failed send would invite sending it a second time.
test('a send that reaches Telegram but fails to cache is not reported as a failed send', async () => {
  let sendCount = 0;
  const { service, store, database } = buildService(
    buildAdapter({
      send: async opts => {
        sendCount += 1;
        return buildRawMessage({ id: 99, peerId: opts.peerId, text: opts.text, out: 1, date: 999 });
      },
    }),
  );
  store.setState({ patch: { composerText: 'hello' } });

  // 'u2' was never upserted by buildService, so the FK from messages.peerId
  // to peers.id rejects the cache write even though the network send above
  // succeeds -- the split this test exists to prove.
  await service.send({ peerId: 'u2', text: 'hello' });

  expect(sendCount).toBe(1);
  expect(store.getState().composerText).toBe('');
  expect(store.getState().statusMessage).not.toContain('Send failed');
  expect(store.getState().statusMessage).toContain('could not save');
  database.close();
});

// Typing during the network round-trip must survive, exactly like a failed
// send -- the response landing is not permission to discard newer input.
test('a send that resolves after the composer changes leaves the newer text alone', async () => {
  const { service, store, database } = buildService(
    buildAdapter({
      send: async opts => {
        store.setState({ patch: { composerText: 'actually let me add more' } });
        return buildRawMessage({ id: 99, peerId: opts.peerId, text: opts.text, out: 1, date: 999 });
      },
    }),
  );
  store.setState({ patch: { composerText: 'on my way' } });
  await service.send({ peerId: 'u1', text: 'on my way' });
  expect(store.getState().composerText).toBe('actually let me add more');
  database.close();
});

// The fallback read itself must not be able to throw: loadHistory() is
// invoked fire-and-forget by its caller, so a second exception escaping the
// catch would become an unhandled rejection instead of a status message.
test('a network failure with an unreadable cache still resolves instead of throwing', async () => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  const store = new ApplicationStoreService();
  const service = new MessageService(
    buildAdapter({ fetchHistory: async () => { throw new Error('offline'); } }),
    database,
    store,
  );
  database.close();

  await expect(service.loadHistory({ peerId: 'u1', limit: 50 })).resolves.toBeUndefined();
  expect(store.getState().statusMessage).toContain('offline');
});
