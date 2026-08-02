import { test, expect } from 'bun:test';

import { ApplicationStoreService } from '../../core/application-store.ts';
import { DatabaseService } from '../../core/cache/index.ts';
import { DialogService, type IDialogAdapter, type IRawDialog } from '../../core/dialog-service.ts';

const buildRawDialog = (overrides: Partial<IRawDialog> = {}): IRawDialog => ({
  peerId: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: 'alice',
  pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 1, readOutboxMaxId: 0, ...overrides,
});

const buildService = (adapter: IDialogAdapter): { service: DialogService; database: DatabaseService; store: ApplicationStoreService } => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  const store = new ApplicationStoreService();
  return { service: new DialogService(adapter, database, store), database, store };
};

test('fetched dialogs land in the store', async () => {
  const { service, store, database } = buildService({ fetchDialogs: async () => [buildRawDialog()] });
  await service.sync();
  expect(store.getState().dialogs.map(dialog => dialog.title)).toEqual(['Alice']);
  database.close();
});

test('dialogs are cached so they survive a restart', async () => {
  const { service, database } = buildService({ fetchDialogs: async () => [buildRawDialog()] });
  await service.sync();
  expect(database.listDialogs()).toHaveLength(1);
  database.close();
});

test('pinned dialogs sort above more recent unpinned ones', async () => {
  const { service, store, database } = buildService({
    fetchDialogs: async () => [
      buildRawDialog({ peerId: 'u1', title: 'Alice', pinned: 0, lastMessageAt: 300 }),
      buildRawDialog({ peerId: 'u2', title: 'Bob', pinned: 1, lastMessageAt: 100 }),
    ],
  });
  await service.sync();
  expect(store.getState().dialogs.map(dialog => dialog.title)).toEqual(['Bob', 'Alice']);
  database.close();
});

test('a second sync updates rather than duplicating', async () => {
  let unreadCount = 1;
  const { service, store, database } = buildService({
    fetchDialogs: async () => [buildRawDialog({ unreadCount })],
  });
  await service.sync();
  unreadCount = 7;
  await service.sync();
  const dialogs = store.getState().dialogs;
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]!.unreadCount).toBe(7);
  database.close();
});

// Going offline must never blank the interface.
test('a network failure leaves the cached list visible', async () => {
  let shouldFail = false;
  const { service, store, database } = buildService({
    fetchDialogs: async () => {
      if (shouldFail) {
        throw new Error('network down');
      }
      return [buildRawDialog()];
    },
  });
  await service.sync();

  // Written straight to the cache, bypassing the adapter entirely, so the
  // store has never seen this row. Only a catch that genuinely re-reads the
  // cache -- not one that merely leaves the store's previous state alone --
  // can make it appear below.
  database.upsertPeer({ id: 'u2', type: 'user', accessHash: 'h2', title: 'Bob', username: 'bob' });
  database.upsertDialog({ peerId: 'u2', pinned: 0, unreadCount: 0, lastMessageAt: 50, topMessageId: 2, readOutboxMaxId: 0 });

  shouldFail = true;
  await service.sync();
  expect(store.getState().dialogs).toHaveLength(2);
  expect(store.getState().statusMessage).toContain('network down');
  database.close();
});

// Task 9: read receipts. read_outbox_max_id existed in the schema unused
// before this task -- this is what actually threads a synced value through
// to the cached row the tick in message-view.tsx reads.
test("a dialog's readOutboxMaxId is cached from the sync", async () => {
  const { service, store, database } = buildService({
    fetchDialogs: async () => [buildRawDialog({ readOutboxMaxId: 42 })],
  });
  await service.sync();
  expect(store.getState().dialogs[0]!.readOutboxMaxId).toBe(42);
  expect(database.listDialogs()[0]!.readOutboxMaxId).toBe(42);
  database.close();
});

// The fallback read itself must not be able to throw: sync() is invoked
// fire-and-forget by its caller, so a second exception escaping the catch
// would become an unhandled rejection instead of a status message on screen.
test('a network failure with an unreadable cache still resolves instead of throwing', async () => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  const store = new ApplicationStoreService();
  const service = new DialogService(
    { fetchDialogs: async () => { throw new Error('network down'); } },
    database,
    store,
  );
  database.close();

  await expect(service.sync()).resolves.toBeUndefined();
  expect(store.getState().statusMessage).toContain('network down');
});
