import { test, expect } from 'bun:test';

import { ApplicationStoreService } from '../../core/application-store.ts';
import { DatabaseService } from '../../core/cache/index.ts';
import { HISTORY_PAGE_SIZE, MessageService, type IMessageAdapter, type IRawMessage } from '../../core/message-service.ts';
import type { IMessageReaction } from '../../core/reactions.ts';
import { MessageOrigins, UpdateService } from '../../core/update-service.ts';

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
  pinMessage: async (): Promise<void> => {},
  react: async (): Promise<IMessageReaction[]> => [],
  forward: async (): Promise<void> => {},
  // MessageService never calls this -- UpdateService (src/__tests__/core/update-service.test.ts)
  // is what exercises it -- but IMessageAdapter requires it, so a stub keeps this fake whole.
  subscribeToNewMessages: () => (): void => {},
  subscribeToReadReceipts: () => (): void => {},
  subscribeToTyping: () => (): void => {},
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

/**
 * Final review, Critical 2. loadHistory's success patch clears statusMessage
 * unconditionally, and main.ts calls it immediately after
 * DifferenceService.catchUp() -- so a warning that messages were lost, written
 * to statusMessage, was erased before the first frame every single launch.
 * integrityWarning is a field loadHistory does not touch at all: not "cleared
 * later", structurally unreachable from here.
 */
test('loadHistory clears the transient status message but never the integrity warning', async () => {
  const { service, store, database } = buildService(buildAdapter({ fetchHistory: async () => [buildRawMessage()] }));
  store.setState({
    patch: {
      statusMessage: 'Send failed: offline',
      integrityWarning: 'Some missed messages could not be saved; tglow will try again next time',
    },
  });

  await service.loadHistory({ peerId: 'u1', limit: 50 });

  expect(store.getState().statusMessage).toBeNull();
  expect(store.getState().integrityWarning)
    .toBe('Some missed messages could not be saved; tglow will try again next time');
  database.close();
});

// The same guarantee on the other three paths that clear statusMessage on
// success, so the warning cannot be lost to an ordinary send either.
test('send, edit and delete leave the integrity warning alone', async () => {
  const { service, store, database } = buildService(buildAdapter());
  database.insertMessages({ messages: [{ peerId: 'u1', id: 1, fromId: 'me', date: 100, text: 'hi', out: 1, entities: [], replyToMessageId: null }] });
  store.setState({ patch: { integrityWarning: 'some history may be missing' } });

  await service.send({ peerId: 'u1', text: 'hello' });
  await service.edit({ peerId: 'u1', messageId: 1, text: 'hello again' });
  await service.delete({ peerId: 'u1', messageIds: [1] });

  expect(store.getState().integrityWarning).toBe('some history may be missing');
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

// A send adds to the window rather than sliding it. Republishing at exactly
// the size already on screen puts the new message at the bottom and pushes the
// oldest one off the top -- invisible at the old fixed limit of 200, and very
// visible now the window is only as big as the user has paged it open.
test('sending keeps everything on screen and adds to it', async () => {
  const { service, store, database } = buildService(buildAdapter());
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'earlier', out: 0, entities: [], replyToMessageId: null }],
  });
  await service.loadHistory({ peerId: 'u1', limit: 1 });
  await service.send({ peerId: 'u1', text: 'on my way' });
  expect(store.getState().messages.map(message => message.text)).toEqual(['earlier', 'on my way']);
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
  const deletes: Array<{ peerId: string; messageIds: number[]; forEveryone: boolean }> = [];
  const harness = buildService(buildAdapter({ delete: async opts => { deletes.push(opts); } }));
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 5, fromId: 'me', date: 100, text: 'oops', out: 1, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageIds: [5] });
  expect(deletes).toEqual([{ peerId: 'u1', messageIds: [5], forEveryone: true }]);
  harness.database.close();
});

test("deleting someone else's message deletes only for you", async () => {
  const deletes: Array<{ peerId: string; messageIds: number[]; forEveryone: boolean }> = [];
  const harness = buildService(buildAdapter({ delete: async opts => { deletes.push(opts); } }));
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 5, fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageIds: [5] });
  expect(deletes).toEqual([{ peerId: 'u1', messageIds: [5], forEveryone: false }]);
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
  await harness.service.delete({ peerId: 'u1', messageIds: [5] });
  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toEqual(['kept']);
  harness.database.close();
});

test('a successful delete for everyone says so on the status line', async () => {
  const harness = buildService(buildAdapter({ delete: async () => {} }));
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 5, fromId: 'me', date: 100, text: 'oops', out: 1, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageIds: [5] });
  expect(harness.store.getState().statusMessage).toContain('everyone');
  harness.database.close();
});

test('a successful delete for yourself only says so on the status line', async () => {
  const harness = buildService(buildAdapter({ delete: async () => {} }));
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 5, fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
  await harness.service.delete({ peerId: 'u1', messageIds: [5] });
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
  await harness.service.delete({ peerId: 'u1', messageIds: [5] });
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
  updateService.apply({
    message: buildRawMessage({ id: 4, peerId: 'u1', date: 200, text: 'new one' }),
    origin: MessageOrigins.LIVE,
  });

  expect(harness.database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(1);
  expect(harness.store.getState().dialogs.find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(1);
  harness.database.close();
});

// ── ranged delete (3dd) ───────────────────────────────────────────────────
//
// Through M1b-2 a range confirmed and deleted one message. These cover the
// three things that made ranged delete worth deferring twice: batching,
// the revoke flag being per-call while ownership is per-message, and what
// the status line says when only part of it went.

const buildRow = (id: number, out: 0 | 1) =>
  ({ peerId: 'u1', id, fromId: out === 1 ? 'me' : 'u1', date: id * 100, text: `m${id}`, out, entities: [], replyToMessageId: null });

const seed = (harness: ReturnType<typeof buildService>, rows: ReturnType<typeof buildRow>[]): void => {
  harness.database.insertMessages({ messages: rows });
  harness.store.setState({ patch: { messages: harness.database.listMessages({ peerId: 'u1', limit: 10 }) } });
};

// One round trip, not three: Telegram's deleteMessages takes an array, and a
// loop would also mean three republishes and three status messages.
test('a ranged delete of your own messages is one adapter call carrying every id', async () => {
  const deletes: Array<{ peerId: string; messageIds: number[]; forEveryone: boolean }> = [];
  const harness = buildService(buildAdapter({ delete: async opts => { deletes.push(opts); } }));
  seed(harness, [buildRow(5, 1), buildRow(6, 1), buildRow(7, 1)]);

  await harness.service.delete({ peerId: 'u1', messageIds: [5, 6, 7] });

  expect(deletes).toEqual([{ peerId: 'u1', messageIds: [5, 6, 7], forEveryone: true }]);
  harness.database.close();
});

// revoke is one flag per call, but whether a delete can reach the other side
// is a fact about each message. Sending a mixed range under either flag would
// be wrong for half of it.
test('a range covering both your messages and theirs splits into two calls, one per revoke flag', async () => {
  const deletes: Array<{ peerId: string; messageIds: number[]; forEveryone: boolean }> = [];
  const harness = buildService(buildAdapter({ delete: async opts => { deletes.push(opts); } }));
  seed(harness, [buildRow(5, 1), buildRow(6, 0), buildRow(7, 1)]);

  await harness.service.delete({ peerId: 'u1', messageIds: [5, 6, 7] });

  expect(deletes).toEqual([
    { peerId: 'u1', messageIds: [5, 7], forEveryone: true },
    { peerId: 'u1', messageIds: [6], forEveryone: false },
  ]);
  harness.database.close();
});

test('every message in a successful range leaves the visible history', async () => {
  const harness = buildService(buildAdapter({ delete: async () => {} }));
  seed(harness, [buildRow(5, 1), buildRow(6, 1), buildRow(7, 1), buildRow(8, 1)]);

  await harness.service.delete({ peerId: 'u1', messageIds: [5, 6, 7] });

  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toEqual(['m8']);
  harness.database.close();
});

test('a ranged delete for everyone counts what it deleted', async () => {
  const harness = buildService(buildAdapter({ delete: async () => {} }));
  seed(harness, [buildRow(5, 1), buildRow(6, 1), buildRow(7, 1)]);

  await harness.service.delete({ peerId: 'u1', messageIds: [5, 6, 7] });

  expect(harness.store.getState().statusMessage).toBe('Deleted 3 for everyone');
  harness.database.close();
});

// Neither "for everyone" nor "for you" is true of a mixed set, and claiming
// either would overstate what actually reached the other side.
test('a mixed range claims neither for-everyone nor for-you', async () => {
  const harness = buildService(buildAdapter({ delete: async () => {} }));
  seed(harness, [buildRow(5, 1), buildRow(6, 0)]);

  await harness.service.delete({ peerId: 'u1', messageIds: [5, 6] });

  expect(harness.store.getState().statusMessage).toBe('Deleted 2 messages');
  harness.database.close();
});

// The half-failure the feature was deferred over. Your own messages go, theirs
// is refused: the cache must lose exactly what left the server, and the status
// line must not say the whole range went.
test('when one batch fails the other still lands, and the status line says how many really went', async () => {
  const harness = buildService(buildAdapter({
    delete: async opts => {
      if (!opts.forEveryone) {
        throw new Error('MESSAGE_DELETE_FORBIDDEN');
      }
    },
  }));
  seed(harness, [buildRow(5, 1), buildRow(6, 0), buildRow(7, 1)]);

  await harness.service.delete({ peerId: 'u1', messageIds: [5, 6, 7] });

  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toEqual(['m6']);
  expect(harness.store.getState().statusMessage).toBe('Deleted 2 of 3: MESSAGE_DELETE_FORBIDDEN');
  harness.database.close();
});

test('when the whole range fails nothing leaves the cache', async () => {
  const harness = buildService(buildAdapter({
    delete: async () => { throw new Error('offline'); },
  }));
  seed(harness, [buildRow(5, 1), buildRow(6, 1)]);

  await harness.service.delete({ peerId: 'u1', messageIds: [5, 6] });

  // listMessages is newest-first -- forDisplay is what reverses it for the
  // view -- so this reads m6, m5 rather than the order they were seeded in.
  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toEqual(['m6', 'm5']);
  expect(harness.store.getState().statusMessage).toContain('offline');
  harness.database.close();
});

test('an empty id list touches neither the network nor the cache', async () => {
  let calls = 0;
  const harness = buildService(buildAdapter({ delete: async () => { calls += 1; } }));
  seed(harness, [buildRow(5, 1)]);

  await harness.service.delete({ peerId: 'u1', messageIds: [] });

  expect(calls).toBe(0);
  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 })).toHaveLength(1);
  harness.database.close();
});

// ── opening a chat lands on the newest message ────────────────────────────

// Where every chat client puts you, and where the unread messages are. The
// cursor drives the viewport, so this is what "scrolled to the bottom" means
// here -- there is no separate scroll offset to set.
test('opening a chat puts the cursor on the newest message', async () => {
  const { service, store, database } = buildService(
    buildAdapter({
      fetchHistory: async () => [1, 2, 3, 4, 5].map(id =>
        buildRawMessage({ id, date: id * 100, text: `msg${id}` })),
    }),
  );

  await service.loadHistory({ peerId: 'u1', limit: 50 });

  expect(store.getState().messageCursor).toBe(4);
  database.close();
});

// Switching from a long chat to a short one used to leave the cursor past the
// end of the new history, pointing at a message that is not there.
test('opening a shorter chat does not leave the cursor past the end', async () => {
  const { service, store, database } = buildService(
    buildAdapter({ fetchHistory: async () => [buildRawMessage({ id: 1, date: 100 })] }),
  );
  store.setState({ patch: { messageCursor: 40 } });

  await service.loadHistory({ peerId: 'u1', limit: 50 });

  expect(store.getState().messageCursor).toBe(0);
  database.close();
});

// An empty chat has no message to sit on, and a cursor of -1 would index
// before the start of the list everywhere it is read.
test('opening an empty chat leaves the cursor at zero', async () => {
  const { service, store, database } = buildService(buildAdapter({ fetchHistory: async () => [] }));
  store.setState({ patch: { messageCursor: 12 } });

  await service.loadHistory({ peerId: 'u1', limit: 50 });

  expect(store.getState().messageCursor).toBe(0);
  database.close();
});

// ── paging backwards ──────────────────────────────────────────────────────

/** `count` messages, newest last, ids ascending from 1. */
const seedHistory = (count: number): IRawMessage[] =>
  Array.from({ length: count }, (unused, index) => buildRawMessage({
    id: index + 1, date: (index + 1) * 100, text: `msg${index + 1}`,
  }));

/** An adapter that serves a fixed history, honouring `beforeId` the way Telegram does. */
const buildPagingAdapter = (history: IRawMessage[]): { adapter: IMessageAdapter; calls: (number | undefined)[] } => {
  const calls: (number | undefined)[] = [];
  const adapter = buildAdapter({
    fetchHistory: async opts => {
      calls.push(opts.beforeId);
      // Newest-first, exclusive of beforeId -- what getMessages({ offsetId })
      // returns.
      const older = opts.beforeId === undefined
        ? history
        : history.filter(message => message.id < opts.beforeId!);
      return [...older].reverse().slice(0, opts.limit);
    },
  });
  return { adapter, calls };
};

test('opening a chat loads one page, not the whole history', async () => {
  const { adapter } = buildPagingAdapter(seedHistory(500));
  const { service, store, database } = buildService(adapter);

  await service.loadHistory({ peerId: 'u1', limit: HISTORY_PAGE_SIZE });

  expect(store.getState().messages).toHaveLength(HISTORY_PAGE_SIZE);
  expect(store.getState().messages[0]!.text).toBe('msg451');
  expect(store.getState().reachedOldest).toBe(false);
  database.close();
});

// The page is prepended, so every existing index shifts. A cursor left alone
// would jump the view backwards by exactly the number of new messages -- the
// classic infinite-scroll lurch.
test('an older page is prepended and the cursor keeps its message', async () => {
  const { adapter } = buildPagingAdapter(seedHistory(500));
  const { service, store, database } = buildService(adapter);
  await service.loadHistory({ peerId: 'u1', limit: HISTORY_PAGE_SIZE });

  store.setState({ patch: { messageCursor: 0 } });
  const under = store.getState().messages[0]!.text;

  await service.loadOlder({ peerId: 'u1' });

  const state = store.getState();
  expect(state.messages).toHaveLength(HISTORY_PAGE_SIZE * 2);
  expect(state.messages[state.messageCursor]!.text).toBe(under);
  expect(state.messageCursor).toBe(HISTORY_PAGE_SIZE);
  database.close();
});

// Exclusive: asking again from the oldest loaded id must not re-serve it.
test('each page asks from the oldest message on screen', async () => {
  const { adapter, calls } = buildPagingAdapter(seedHistory(500));
  const { service, store, database } = buildService(adapter);
  await service.loadHistory({ peerId: 'u1', limit: HISTORY_PAGE_SIZE });

  await service.loadOlder({ peerId: 'u1' });
  await service.loadOlder({ peerId: 'u1' });

  expect(calls).toEqual([undefined, 451, 401]);
  expect(store.getState().messages).toHaveLength(HISTORY_PAGE_SIZE * 3);
  database.close();
});

// A short page is the beginning of the conversation. Without noticing, every
// keystroke at the top would be a round trip that returns nothing.
test('a page shorter than asked for means there is no more, and asking stops', async () => {
  const { adapter, calls } = buildPagingAdapter(seedHistory(60));
  const { service, store, database } = buildService(adapter);
  await service.loadHistory({ peerId: 'u1', limit: HISTORY_PAGE_SIZE });

  await service.loadOlder({ peerId: 'u1' });
  expect(store.getState().reachedOldest).toBe(true);
  expect(store.getState().messages).toHaveLength(60);

  await service.loadOlder({ peerId: 'u1' });
  await service.loadOlder({ peerId: 'u1' });
  expect(calls).toEqual([undefined, 11]);
  database.close();
});

// A chat whose whole history fits in the first page has nothing behind it, and
// nothing should ever be asked for.
test('a chat shorter than a page never asks for more', async () => {
  const { adapter, calls } = buildPagingAdapter(seedHistory(5));
  const { service, store, database } = buildService(adapter);

  await service.loadHistory({ peerId: 'u1', limit: HISTORY_PAGE_SIZE });
  expect(store.getState().reachedOldest).toBe(true);

  await service.loadOlder({ peerId: 'u1' });
  expect(calls).toEqual([undefined]);
  database.close();
});

// The cache often holds more than the window shows -- a previous session that
// paged further back, or a catch-up's own fetch. Reading it costs no round
// trip and works with no connection at all.
test('the cache is used before the network', async () => {
  const { adapter, calls } = buildPagingAdapter(seedHistory(500));
  const { service, store, database } = buildService(adapter);
  database.insertMessages({
    messages: seedHistory(200).map(message => ({ ...message, peerId: 'u1' })),
  });

  await service.loadHistory({ peerId: 'u1', limit: HISTORY_PAGE_SIZE });
  await service.loadOlder({ peerId: 'u1' });

  // Only the open-the-chat fetch: the older page came out of the cache.
  expect(calls).toEqual([undefined]);
  expect(store.getState().messages).toHaveLength(HISTORY_PAGE_SIZE * 2);
  database.close();
});

// Reaching the top and staying there fires the effect on every keystroke; only
// one of them may become a request.
test('a page already in flight is not asked for twice', async () => {
  const { adapter, calls } = buildPagingAdapter(seedHistory(500));
  // A box rather than a `let`: TypeScript narrows a local assigned only inside
  // a callback to `null` and then refuses to call it.
  const gate: { release: (() => void) | null } = { release: null };
  const gated: IMessageAdapter = {
    ...adapter,
    fetchHistory: async opts => {
      if (opts.beforeId !== undefined) {
        await new Promise<void>(resolve => { gate.release = resolve; });
      }
      return adapter.fetchHistory(opts);
    },
  };
  const { service, store, database } = buildService(gated);
  await service.loadHistory({ peerId: 'u1', limit: HISTORY_PAGE_SIZE });

  const first = service.loadOlder({ peerId: 'u1' });
  await service.loadOlder({ peerId: 'u1' });
  await service.loadOlder({ peerId: 'u1' });
  expect(store.getState().loadingOlder).toBe(true);

  gate.release?.();
  await first;

  expect(calls.filter(call => call !== undefined)).toEqual([451]);
  expect(store.getState().loadingOlder).toBe(false);
  database.close();
});

// Offline is not an error state for reading: the window stays exactly as it
// was, and the failure is reported rather than swallowed.
test('a failed page leaves the window alone and says so', async () => {
  const { adapter } = buildPagingAdapter(seedHistory(500));
  let failing = false;
  const { service, store, database } = buildService({
    ...adapter,
    fetchHistory: async opts => {
      if (failing) {
        throw new Error('NETWORK_DOWN');
      }
      return adapter.fetchHistory(opts);
    },
  });
  await service.loadHistory({ peerId: 'u1', limit: HISTORY_PAGE_SIZE });
  failing = true;

  await service.loadOlder({ peerId: 'u1' });

  const state = store.getState();
  expect(state.messages).toHaveLength(HISTORY_PAGE_SIZE);
  expect(state.statusMessage).toContain('NETWORK_DOWN');
  // The network failed, not the history -- the pages may still be there when
  // it comes back, so it must stay willing to ask again.
  expect(state.reachedOldest).toBe(false);
  expect(state.loadingOlder).toBe(false);
  database.close();
});

// Opening another chat mid-flight must not prepend one conversation's history
// to another's.
test('a page that lands after the chat changed is dropped', async () => {
  const { adapter } = buildPagingAdapter(seedHistory(500));
  // A box rather than a `let`: TypeScript narrows a local assigned only inside
  // a callback to `null` and then refuses to call it.
  const gate: { release: (() => void) | null } = { release: null };
  const { service, store, database } = buildService({
    ...adapter,
    fetchHistory: async opts => {
      if (opts.beforeId !== undefined) {
        await new Promise<void>(resolve => { gate.release = resolve; });
      }
      return adapter.fetchHistory(opts);
    },
  });
  database.upsertPeer({ id: 'u2', type: 'user', accessHash: 'h', title: 'Bob', username: null });
  await service.loadHistory({ peerId: 'u1', limit: HISTORY_PAGE_SIZE });

  const inFlight = service.loadOlder({ peerId: 'u1' });
  store.setState({ patch: { activePeerId: 'u2', messages: [], messageCursor: 0 } });
  gate.release?.();
  await inFlight;

  expect(store.getState().activePeerId).toBe('u2');
  expect(store.getState().messages).toEqual([]);
  database.close();
});
