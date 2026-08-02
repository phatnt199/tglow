import { test, expect } from 'bun:test';

import { ApplicationStoreService } from '../../src/core/application-store.ts';
import { DatabaseService } from '../../src/core/cache/index.ts';
import { DialogService, type IDialogAdapter, type IRawDialog } from '../../src/core/dialog-service.ts';

const buildRawDialog = (overrides: Partial<IRawDialog> = {}): IRawDialog => ({
  peerId: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: 'alice',
  pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 1, ...overrides,
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
  shouldFail = true;
  await service.sync();
  expect(store.getState().dialogs).toHaveLength(1);
  expect(store.getState().statusMessage).toContain('network down');
  database.close();
});
