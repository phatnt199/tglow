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

test('a network failure falls back to the cache', async () => {
  const { service, store, database } = buildService(
    buildAdapter({ fetchHistory: async () => { throw new Error('offline'); } }),
  );
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'cached', out: 0 }],
  });
  await service.loadHistory({ peerId: 'u1', limit: 50 });
  expect(store.getState().messages.map(message => message.text)).toEqual(['cached']);
  expect(store.getState().statusMessage).toContain('offline');
  database.close();
});

test('sending appends the message to the view and clears the composer', async () => {
  const { service, store, database } = buildService(buildAdapter());
  store.setState({ patch: { activePeerId: 'u1', composerText: 'on my way' } });
  await service.send({ peerId: 'u1', text: 'on my way' });
  expect(store.getState().messages.map(message => message.text)).toEqual(['on my way']);
  expect(store.getState().composerText).toBe('');
  database.close();
});

test('empty and whitespace-only messages are not sent', async () => {
  let sent = 0;
  const { service, database } = buildService(
    buildAdapter({ send: async opts => { sent += 1; return buildRawMessage({ text: opts.text }); } }),
  );
  await service.send({ peerId: 'u1', text: '   ' });
  expect(sent).toBe(0);
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
