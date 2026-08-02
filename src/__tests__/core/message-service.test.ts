import { test, expect } from 'bun:test';

import { ApplicationStoreService } from '../../core/application-store.ts';
import { DatabaseService } from '../../core/cache/index.ts';
import { MessageService, type IMessageAdapter, type IRawMessage } from '../../core/message-service.ts';
import { UpdateService } from '../../core/update-service.ts';

const buildRawMessage = (overrides: Partial<IRawMessage> = {}): IRawMessage => ({
  id: 1, peerId: 'u1', fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null, ...overrides,
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
  edit: async opts => buildRawMessage({ id: opts.messageId, peerId: opts.peerId, text: opts.text, out: 1 }),
  delete: async (): Promise<void> => {},
  markRead: async (): Promise<void> => {},
  // MessageService never calls this -- UpdateService (src/__tests__/core/update-service.test.ts)
  // is what exercises it -- but IMessageAdapter requires it, so a stub keeps this fake whole.
  subscribeToNewMessages: () => (): void => {},
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
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'cached first', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'cached second', out: 0, entities: [], replyToMessageId: null },
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
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'earlier', out: 0, entities: [], replyToMessageId: null }],
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
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'earlier', out: 0, entities: [], replyToMessageId: null }],
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

test('sending with a reply target passes it to the adapter', async () => {
  const sent: Array<{ text: string; replyToMessageId?: number }> = [];
  const harness = buildService(buildAdapter({
    send: async opts => { sent.push(opts); return buildRawMessage({ text: opts.text }); },
  }));
  await harness.service.send({ peerId: 'u1', text: 'sure', replyToMessageId: 7 });
  expect(sent[0]!.replyToMessageId).toBe(7);
  harness.database.close();
});

test('a successful reply clears the reply target', async () => {
  const harness = buildService(buildAdapter());
  harness.store.setState({ patch: { activePeerId: 'u1', composerText: 'sure', replyToMessageId: 7 } });
  await harness.service.send({ peerId: 'u1', text: 'sure', replyToMessageId: 7 });
  expect(harness.store.getState().replyToMessageId).toBeNull();
  harness.database.close();
});

test('a failed reply keeps both the text and the reply target', async () => {
  const harness = buildService(buildAdapter({ send: async () => { throw new Error('FLOOD_WAIT_30'); } }));
  harness.store.setState({ patch: { composerText: 'sure', replyToMessageId: 7 } });
  await harness.service.send({ peerId: 'u1', text: 'sure', replyToMessageId: 7 });
  expect(harness.store.getState().composerText).toBe('sure');
  expect(harness.store.getState().replyToMessageId).toBe(7);
  harness.database.close();
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

test('editing sends the new text for the right message id', async () => {
  const edits: Array<{ peerId: string; messageId: number; text: string }> = [];
  const harness = buildService(buildAdapter({
    edit: async opts => { edits.push(opts); return buildRawMessage({ id: opts.messageId, text: opts.text }); },
  }));
  await harness.service.edit({ peerId: 'u1', messageId: 5, text: 'fixed' });
  expect(edits).toEqual([{ peerId: 'u1', messageId: 5, text: 'fixed' }]);
  harness.database.close();
});

test('a successful edit updates the cached message rather than adding one', async () => {
  const harness = buildService(buildAdapter({
    edit: async opts => buildRawMessage({ id: opts.messageId, text: opts.text }),
  }));
  harness.database.insertMessages({ messages: [{ peerId: 'u1', id: 5, fromId: 'me', date: 100, text: 'typo', out: 1, entities: [], replyToMessageId: null }] });
  await harness.service.edit({ peerId: 'u1', messageId: 5, text: 'fixed' });
  const rows = harness.database.listMessages({ peerId: 'u1', limit: 10 });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toBe('fixed');
  harness.database.close();
});

test('a failed edit keeps the text in the composer', async () => {
  const harness = buildService(buildAdapter({ edit: async () => { throw new Error('MESSAGE_NOT_MODIFIED'); } }));
  harness.store.setState({ patch: { composerText: 'fixed', editingMessageId: 5 } });
  await harness.service.edit({ peerId: 'u1', messageId: 5, text: 'fixed' });
  expect(harness.store.getState().composerText).toBe('fixed');
  expect(harness.store.getState().editingMessageId).toBe(5);
  harness.database.close();
});

// Task 8: delete. forEveryone is decided here, from state.messages -- the
// same array DELETE_REQUEST itself resolved the id from -- rather than
// trusted from a caller, so the confirmation and the deletion can never
// disagree about whose message this is.
test('deleting your own message asks the adapter to delete it for everyone', async () => {
  const deletes: Array<{ peerId: string; messageId: number; forEveryone: boolean }> = [];
  const harness = buildService(buildAdapter({ delete: async opts => { deletes.push(opts); } }));
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 5, fromId: 'me', date: 100, text: 'oops', out: 1, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageId: 5 });
  expect(deletes).toEqual([{ peerId: 'u1', messageId: 5, forEveryone: true }]);
  harness.database.close();
});

test("deleting someone else's message deletes only for you", async () => {
  const deletes: Array<{ peerId: string; messageId: number; forEveryone: boolean }> = [];
  const harness = buildService(buildAdapter({ delete: async opts => { deletes.push(opts); } }));
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 5, fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageId: 5 });
  expect(deletes).toEqual([{ peerId: 'u1', messageId: 5, forEveryone: false }]);
  harness.database.close();
});

// The row must stay in the cache, only flagged -- removing it would leave a
// hole in the id range that history paging reasons about. listMessages
// already filters deleted rows out, so this also proves the cache write ran.
test('a successful delete marks the cached row deleted rather than removing it', async () => {
  const harness = buildService(buildAdapter({ delete: async () => {} }));
  harness.database.insertMessages({
    messages: [
      { peerId: 'u1', id: 5, fromId: 'me', date: 100, text: 'oops', out: 1, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 6, fromId: 'me', date: 200, text: 'kept', out: 1, entities: [], replyToMessageId: null },
    ],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageId: 5 });
  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toEqual(['kept']);
  harness.database.close();
});

test('a successful delete for everyone says so on the status line', async () => {
  const harness = buildService(buildAdapter({ delete: async () => {} }));
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 5, fromId: 'me', date: 100, text: 'oops', out: 1, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageId: 5 });
  expect(harness.store.getState().statusMessage).toContain('everyone');
  harness.database.close();
});

test('a successful delete for yourself only says so on the status line', async () => {
  const harness = buildService(buildAdapter({ delete: async () => {} }));
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 5, fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageId: 5 });
  const status = harness.store.getState().statusMessage;
  expect(status).not.toContain('everyone');
  expect(status).toBeTruthy();
  harness.database.close();
});

// The irreversible half of this task: a rejected delete must not touch the
// cache, and must say so rather than silently doing nothing.
test('a failed delete reports failure and leaves the message cached', async () => {
  const harness = buildService(buildAdapter({ delete: async () => { throw new Error('MESSAGE_DELETE_FORBIDDEN'); } }));
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 5, fromId: 'me', date: 100, text: 'oops', out: 1, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageId: 5 });
  expect(harness.store.getState().statusMessage).toContain('MESSAGE_DELETE_FORBIDDEN');
  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toEqual(['oops']);
  harness.database.close();
});

// Task 9: mark as read. markRead is deliberately not called by loadHistory
// itself (see the next test) -- App decides when the user has actually seen
// the newest message, and calls this separately once it has.
test('opening a chat marks its newest message read', async () => {
  const read: Array<{ peerId: string; maxId: number }> = [];
  const harness = buildService(buildAdapter({ markRead: async opts => { read.push(opts); } }));
  await harness.service.loadHistory({ peerId: 'u1', limit: 50 });
  await harness.service.markRead({ peerId: 'u1', maxId: 9 });
  expect(read).toEqual([{ peerId: 'u1', maxId: 9 }]);
  harness.database.close();
});

// Reading is an explicit act. Auto-reading what the user has not seen is how a
// client loses trust. Load-bearing: verified (see task-9-report.md) that this
// genuinely fails if loadHistory is made to call markRead on its own --
// fetchHistory is given a real message on purpose, not left at buildAdapter's
// empty default, so a hypothetical regression gated on "is there anything to
// mark" cannot slip past this test the way an empty history would let it.
test('a chat merely present in the list is never marked read', async () => {
  const read: unknown[] = [];
  const harness = buildService(buildAdapter({
    fetchHistory: async () => [buildRawMessage({ id: 9, date: 100, text: 'hi' })],
    markRead: async opts => { read.push(opts); },
  }));
  await harness.service.loadHistory({ peerId: 'u1', limit: 50 });
  expect(read).toEqual([]);
  harness.database.close();
});

test('marking read twice within the debounce window calls the adapter once', async () => {
  const read: unknown[] = [];
  const harness = buildService(buildAdapter({ markRead: async opts => { read.push(opts); } }));
  await harness.service.markRead({ peerId: 'u1', maxId: 9 });
  await harness.service.markRead({ peerId: 'u1', maxId: 9 });
  expect(read).toHaveLength(1);
  harness.database.close();
});

// The debounce is keyed per peer, not a single shared timestamp -- reading
// one chat must not silently swallow a mark-read for a different one that
// happens to land in the same two-second window.
test('the debounce is scoped per peer, not shared across every chat', async () => {
  const read: Array<{ peerId: string; maxId: number }> = [];
  const harness = buildService(buildAdapter({ markRead: async opts => { read.push(opts); } }));
  await harness.service.markRead({ peerId: 'u1', maxId: 9 });
  await harness.service.markRead({ peerId: 'u2', maxId: 3 });
  expect(read).toEqual([{ peerId: 'u1', maxId: 9 }, { peerId: 'u2', maxId: 3 }]);
  harness.database.close();
});

test('a failed markRead is logged and does not reject', async () => {
  const harness = buildService(buildAdapter({ markRead: async () => { throw new Error('offline'); } }));
  await expect(harness.service.markRead({ peerId: 'u1', maxId: 9 })).resolves.toBeUndefined();
  harness.database.close();
});

// Gap 4d (task-11-report.md): spec §3.3, "the dialog's unread count clears
// locally and in the chat list" -- both the cache (what the next
// listDialogs() reads) and the store (what the sidebar is currently
// rendering from) have to move, or the badge sits stale until the next
// restart the way it did before this task.
test("a successful markRead clears the dialog's unread count in the cache and republishes the dialog list", async () => {
  const harness = buildService(buildAdapter({ markRead: async (): Promise<void> => {} }));
  harness.database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 5, lastMessageAt: 100, topMessageId: 3, readOutboxMaxId: 0 });
  await harness.service.markRead({ peerId: 'u1', maxId: 3 });

  expect(harness.database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(0);
  expect(harness.store.getState().dialogs.find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(0);
  harness.database.close();
});

// The clear is conditioned on the network call actually succeeding -- a
// markRead that never reached the server has not made anything read, so the
// badge staying up is correct, not a bug.
test('a failed markRead leaves the unread count untouched', async () => {
  const harness = buildService(buildAdapter({ markRead: async () => { throw new Error('offline'); } }));
  harness.database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 5, lastMessageAt: 100, topMessageId: 3, readOutboxMaxId: 0 });
  await harness.service.markRead({ peerId: 'u1', maxId: 3 });

  expect(harness.database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(5);
  harness.database.close();
});

// A dialog markRead is called for before DialogService.sync() has ever
// populated its row must not throw -- clearUnreadCount's own no-op-on-missing-row
// behaviour (database.test.ts) has to actually reach all the way through here.
test('markRead for a peer with no dialog row yet does not throw', async () => {
  const harness = buildService(buildAdapter({ markRead: async (): Promise<void> => {} }));
  await expect(harness.service.markRead({ peerId: 'u1', maxId: 3 })).resolves.toBeUndefined();
  harness.database.close();
});

// The chosen behaviour for "a message arrives while you're reading": the
// clear is an unconditional zero, not a decrement or a remembered delta, so a
// live arrival afterward increments from that real, freshly-read baseline
// (UpdateService.touchDialog re-reads the cache, not a stale snapshot) rather
// than resurrecting whatever the count was before the clear. Chains a real
// UpdateService onto the same database/store MessageService just wrote to --
// exactly how main.ts wires the two -- rather than asserting the reasoning
// on paper without exercising the real cross-service path.
test('a message arriving after a chat is marked read counts as a fresh unread, not a resurrected one', async () => {
  const harness = buildService(buildAdapter({ markRead: async (): Promise<void> => {} }));
  harness.database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 5, lastMessageAt: 100, topMessageId: 3, readOutboxMaxId: 0 });
  await harness.service.markRead({ peerId: 'u1', maxId: 3 });
  expect(harness.database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(0);

  const updateService = new UpdateService(buildAdapter(), harness.database, harness.store);
  updateService.apply(buildRawMessage({ id: 4, peerId: 'u1', date: 200, text: 'new one' }));

  expect(harness.database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(1);
  expect(harness.store.getState().dialogs.find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(1);
  harness.database.close();
});
