import { test, expect } from 'bun:test';

import { Api } from 'teleproto';

import { ApplicationStoreService } from '../../core/application-store.ts';
import { DatabaseService, type IMessageRow } from '../../core/cache/index.ts';
import { ReadDirections, type ILiveMessage, type IMessageAdapter, type IRawMessage, type IReadReceipt } from '../../core/message-service.ts';
import type { ITypingStatus } from '../../core/typing-status.ts';
import { buildMessageAdapter } from '../../core/telegram-adapter.ts';
import type { IMessageReaction } from '../../core/reactions.ts';
import type { IPresence } from '../../core/presence.ts';
import { MessageOrigins, UpdateService } from '../../core/update-service.ts';

const buildRawMessage = (overrides: Partial<IRawMessage> = {}): IRawMessage => ({
  id: 1, peerId: 'u1', fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null, ...overrides,
});

const buildRow = (overrides: Partial<IMessageRow> = {}): IMessageRow => ({
  peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null, ...overrides,
});

/** A fake IMessageAdapter that lets a test fire a "live" message on demand, exactly like DialogService/MessageService's own adapter fakes but with a subscription to drive instead of a promise to resolve. */
const buildAdapter = (): {
  adapter: IMessageAdapter;
  emit: (message: IRawMessage) => void;
  emitLive: (live: ILiveMessage) => void;
  emitReadReceipt: (receipt: IReadReceipt) => void;
  emitPresence: (change: { peerId: string; presence: IPresence }) => void;
  emitReactions: (change: { peerId: string; messageId: number; reactions: IMessageReaction[] }) => void;
  isSubscribed: () => boolean;
} => {
  let onMessage: ((live: ILiveMessage) => void) | null = null;
  let onReadReceipt: ((receipt: IReadReceipt) => void) | null = null;
  let onTyping: ((status: ITypingStatus) => void) | null = null;
  let onPresence: ((change: { peerId: string; presence: IPresence }) => void) | null = null;
  let onReactions: ((change: { peerId: string; messageId: number; reactions: IMessageReaction[] }) => void) | null = null;
  const adapter: IMessageAdapter = {
    fetchHistory: async () => [],
    send: async opts => buildRawMessage({ peerId: opts.peerId, text: opts.text }),
    edit: async opts => buildRawMessage({ id: opts.messageId, peerId: opts.peerId, text: opts.text }),
    // UpdateService never calls this -- MessageService.delete (see
    // message-service.test.ts) is what exercises it -- but IMessageAdapter
    // requires it, so a stub keeps this fake whole.
    delete: async (): Promise<void> => {},
    // Same reasoning as delete above -- MessageService.markRead (see
    // message-service.test.ts) is what exercises this.
    markRead: async (): Promise<void> => {},
    pinMessage: async (): Promise<void> => {},
  react: async (): Promise<IMessageReaction[]> => [],
  forward: async (): Promise<void> => {},
  sendFile: async (opts): Promise<IRawMessage> => buildRawMessage({ id: 98, peerId: opts.peerId, text: opts.caption, out: 1 }),
    subscribeToNewMessages: subscribeOpts => {
      onMessage = subscribeOpts.onMessage;
      return (): void => {
        onMessage = null;
      };
    },
    subscribeToReadReceipts: subscribeOpts => {
      onReadReceipt = subscribeOpts.onReadReceipt;
      return (): void => {
        onReadReceipt = null;
      };
    },
    subscribeToTyping: subscribeOpts => {
      onTyping = subscribeOpts.onTyping;
      return (): void => {
        onTyping = null;
      };
    },
    subscribeToPresence: subscribeOpts => {
      onPresence = subscribeOpts.onPresence;
      return (): void => {
        onPresence = null;
      };
    },
    subscribeToReactions: subscribeOpts => {
      onReactions = subscribeOpts.onReactions;
      return (): void => {
        onReactions = null;
      };
    },
    downloadThumbnail: async (): Promise<Uint8Array | null> => null,
    downloadMedia: async (): Promise<Uint8Array | null> => null,
  };
  return {
    // The common case: a message with no pts worth recording, which is what
    // every test written before the live path persisted state was asserting.
    emit: (message: IRawMessage): void => onMessage?.({ message, pts: null, channelPts: null }),
    emitLive: (live: ILiveMessage): void => onMessage?.(live),
    emitReadReceipt: (receipt: IReadReceipt): void => onReadReceipt?.(receipt),
    emitPresence: (change: { peerId: string; presence: IPresence }): void => onPresence?.(change),
    emitReactions: (change: { peerId: string; messageId: number; reactions: IMessageReaction[] }): void => onReactions?.(change),
    // Both subscriptions, so a test can tell that stop() released each of them
    // rather than only the one start() happened to return last.
    isSubscribed: (): boolean => onMessage !== null || onReadReceipt !== null,
    adapter,
  };
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

// --- Critical 1: origin, and the unread count ------------------------------

test('a live message increments the unread count', () => {
  const { adapter, emit } = buildAdapter();
  const { service, database } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 5, lastMessageAt: 100, topMessageId: 1, readOutboxMaxId: 0 });
  service.start();

  emit(buildRawMessage({ id: 2, peerId: 'u1', date: 200 }));

  expect(database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(6);
  database.close();
});

/**
 * The badge half of Critical 1, at the unit that decides it. The server's
 * unreadCount, written by DialogService.sync() moments earlier, already counts
 * every message a backfill replays -- so a backfill must move the ordering
 * fields and nothing else.
 */
test('a backfilled message leaves the unread count exactly where the server put it', () => {
  const { adapter } = buildAdapter();
  const { service, database } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 5, lastMessageAt: 100, topMessageId: 1, readOutboxMaxId: 0 });

  service.apply({ message: buildRawMessage({ id: 2, peerId: 'u1', date: 200 }), origin: MessageOrigins.BACKFILL });

  const dialog = database.listDialogs().find(row => row.peerId === 'u1');
  expect(dialog?.unreadCount).toBe(5);
  expect(dialog?.topMessageId).toBe(2);
  expect(dialog?.lastMessageAt).toBe(200);
  database.close();
});

test('a live message the user sent themselves still never counts as unread', () => {
  const { adapter, emit } = buildAdapter();
  const { service, database } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 5, lastMessageAt: 100, topMessageId: 1, readOutboxMaxId: 0 });
  service.start();

  emit(buildRawMessage({ id: 2, peerId: 'u1', date: 200, out: 1 }));

  expect(database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(5);
  database.close();
});

// --- Critical 1: the adapter reads the account pts off the real update ------
//
// Real Api.* instances, not hand-rolled objects: the className strings and the
// pts field are the whole risk. UpdateNewChannelMessage carries a pts too, and
// it is the one that must never be stored -- it numbers that channel's own
// sequence, so writing it into the account-wide row sends the next
// getDifference somewhere the account never was.

const buildSubscribedClient = (): { client: any; fire: (event: unknown) => void } => {
  let handler: ((event: unknown) => void) | null = null;
  return {
    client: {
      addEventHandler: (callback: (event: unknown) => void): void => { handler = callback; },
      removeEventHandler: (): void => { handler = null; },
    },
    fire: (event: unknown): void => { handler?.(event); },
  };
};

const buildApiMessage = (): Api.Message =>
  new Api.Message({ id: 7, peerId: new Api.PeerUser({ userId: BigInt(1) as any }), date: 500, message: 'live' });

test('a private-chat update hands its account pts to the subscriber', () => {
  const { client, fire } = buildSubscribedClient();
  const received: ILiveMessage[] = [];
  buildMessageAdapter({ client }).subscribeToNewMessages({ onMessage: live => { received.push(live); } });

  const message = buildApiMessage();
  fire({ message, originalUpdate: new Api.UpdateNewMessage({ message, pts: 4242, ptsCount: 1 }) });

  expect(received.map(live => live.pts)).toEqual([4242]);
  expect(received[0]?.message.text).toBe('live');
});

test('a channel update reports a null pts rather than corrupting the account state', () => {
  const { client, fire } = buildSubscribedClient();
  const received: ILiveMessage[] = [];
  buildMessageAdapter({ client }).subscribeToNewMessages({ onMessage: live => { received.push(live); } });

  const message = buildApiMessage();
  fire({ message, originalUpdate: new Api.UpdateNewChannelMessage({ message, pts: 9, ptsCount: 1 }) });

  expect(received.map(live => live.pts)).toEqual([null]);
  // The message itself still arrives -- a channel message is still a message.
  expect(received[0]?.message.text).toBe('live');
});

test('updateShortMessage, the other private-chat delivery shape, carries its pts too', () => {
  const { client, fire } = buildSubscribedClient();
  const received: ILiveMessage[] = [];
  buildMessageAdapter({ client }).subscribeToNewMessages({ onMessage: live => { received.push(live); } });

  fire({
    message: buildApiMessage(),
    originalUpdate: new Api.UpdateShortMessage({
      id: 7, userId: BigInt(1) as any, message: 'live', pts: 88, ptsCount: 1, date: 500,
    }),
  });

  expect(received.map(live => live.pts)).toEqual([88]);
});

// ── read receipts ─────────────────────────────────────────────────────────
//
// The second tick. Before UpdateService subscribed to these, readOutboxMaxId
// was written only by DialogService.sync() at startup, so a message sent and
// read while you watched kept its single tick until the next launch.

test('a read receipt advances the chat readOutboxMaxId, so the ticks turn read', () => {
  const { adapter, emitReadReceipt } = buildAdapter();
  const { service, database } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 9, readOutboxMaxId: 3 });
  service.start();

  emitReadReceipt({ peerId: 'u1', maxId: 9, direction: ReadDirections.OUTBOX, stillUnreadCount: null });

  expect(database.listDialogs().find(dialog => dialog.peerId === 'u1')?.readOutboxMaxId).toBe(9);
  database.close();
});

// app.tsx feeds MessageView from state.dialogs, so a database write nothing
// republished would leave the ticks on screen exactly as they were.
test('a read receipt republishes the dialogs, which is what redraws the ticks', () => {
  const { adapter, emitReadReceipt } = buildAdapter();
  const { service, database, store } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 9, readOutboxMaxId: 0 });
  store.setState({ patch: { dialogs: database.listDialogs() } });
  service.start();

  emitReadReceipt({ peerId: 'u1', maxId: 9, direction: ReadDirections.OUTBOX, stillUnreadCount: null });

  expect(store.getState().dialogs.find(dialog => dialog.peerId === 'u1')?.readOutboxMaxId).toBe(9);
  database.close();
});

// Receipts carry no ordering guarantee, and a tick that has turned read must
// never turn back into a single tick.
test('a receipt with a lower maxId than one already applied does not walk the ticks backwards', () => {
  const { adapter, emitReadReceipt } = buildAdapter();
  const { service, database } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 9, readOutboxMaxId: 9 });
  service.start();

  emitReadReceipt({ peerId: 'u1', maxId: 4, direction: ReadDirections.OUTBOX, stillUnreadCount: null });

  expect(database.listDialogs().find(dialog => dialog.peerId === 'u1')?.readOutboxMaxId).toBe(9);
  database.close();
});

// Advancing a chat the dialog list has never seen would have to invent its
// pinned/lastMessageAt/topMessageId, putting a phantom row with a zero
// timestamp in the sidebar.
test('a receipt for a chat with no dialog row is a no-op, not a phantom chat', () => {
  const { adapter, emitReadReceipt } = buildAdapter();
  const { service, database } = buildService(adapter);
  service.start();

  emitReadReceipt({ peerId: 'u2', maxId: 5, direction: ReadDirections.OUTBOX, stillUnreadCount: null });

  expect(database.listDialogs()).toEqual([]);
  database.close();
});

test('stopping the service releases the read-receipt subscription too', () => {
  const { adapter, isSubscribed } = buildAdapter();
  const { service, database } = buildService(adapter);

  const stop = service.start();
  expect(isSubscribed()).toBe(true);
  stop();

  expect(isSubscribed()).toBe(false);
  database.close();
});

// The two update classes are not interchangeable: UpdateReadHistoryOutbox
// carries a Peer union, UpdateReadChannelOutbox a bare unmarked channelId and
// no peer at all. Deriving one the other's way yields an id no dialog matches.
test('a private-chat read receipt derives the unmarked peer id from its Peer', () => {
  const { client, fire } = buildSubscribedClient();
  const received: IReadReceipt[] = [];
  buildMessageAdapter({ client }).subscribeToReadReceipts({ onReadReceipt: receipt => { received.push(receipt); } });

  fire(new Api.UpdateReadHistoryOutbox({
    peer: new Api.PeerUser({ userId: BigInt(4242) as any }), maxId: 17, pts: 5, ptsCount: 1,
  }));

  expect(received).toEqual([
    { peerId: '4242', maxId: 17, direction: ReadDirections.OUTBOX, stillUnreadCount: null },
  ]);
});

test('a channel read receipt reads its bare channelId, which is already unmarked', () => {
  const { client, fire } = buildSubscribedClient();
  const received: IReadReceipt[] = [];
  buildMessageAdapter({ client }).subscribeToReadReceipts({ onReadReceipt: receipt => { received.push(receipt); } });

  fire(new Api.UpdateReadChannelOutbox({ channelId: BigInt(777) as any, maxId: 30 }));

  expect(received).toEqual([
    { peerId: '777', maxId: 30, direction: ReadDirections.OUTBOX, stillUnreadCount: null },
  ]);
});

// The inbox pair says what THIS account read elsewhere -- the phone, the
// desktop app. It reaches the subscriber, but tagged as its own direction:
// treating one as an outbox receipt would mark your own messages seen because
// you read theirs.
test('an inbox read update arrives tagged inbox, carrying the server-side unread count', () => {
  const { client, fire } = buildSubscribedClient();
  const received: IReadReceipt[] = [];
  buildMessageAdapter({ client }).subscribeToReadReceipts({ onReadReceipt: receipt => { received.push(receipt); } });

  fire(new Api.UpdateReadHistoryInbox({
    peer: new Api.PeerUser({ userId: BigInt(4242) as any }), maxId: 17, stillUnreadCount: 2, pts: 5, ptsCount: 1,
  }));

  expect(received).toEqual([
    { peerId: '4242', maxId: 17, direction: ReadDirections.INBOX, stillUnreadCount: 2 },
  ]);
});

test('a channel inbox read reads its bare channelId, like its outbox twin', () => {
  const { client, fire } = buildSubscribedClient();
  const received: IReadReceipt[] = [];
  buildMessageAdapter({ client }).subscribeToReadReceipts({ onReadReceipt: receipt => { received.push(receipt); } });

  fire(new Api.UpdateReadChannelInbox({ channelId: BigInt(777) as any, maxId: 30, stillUnreadCount: 5, pts: 2 }));

  expect(received).toEqual([
    { peerId: '777', maxId: 30, direction: ReadDirections.INBOX, stillUnreadCount: 5 },
  ]);
});

// The point of the whole inbox direction: read the chat on your phone, and the
// badge in tglow stops advertising messages you have already seen.
test('reading a chat elsewhere clears its unread badge here', () => {
  const { adapter, emitReadReceipt } = buildAdapter();
  const { service, database, store } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 9, readOutboxMaxId: 0 });
  store.setState({ patch: { dialogs: database.listDialogs() } });
  service.start();

  emitReadReceipt({ peerId: 'u1', maxId: 9, direction: ReadDirections.INBOX, stillUnreadCount: 0 });

  expect(database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(0);
  expect(store.getState().dialogs.find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(0);
  database.close();
});

// Partly read elsewhere: the server's own figure is taken rather than zeroed,
// because tglow cannot know how many of the messages below maxId it counted.
test('a partial read elsewhere takes the server count rather than clearing the badge', () => {
  const { adapter, emitReadReceipt } = buildAdapter();
  const { service, database } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 9, readOutboxMaxId: 0 });
  service.start();

  emitReadReceipt({ peerId: 'u1', maxId: 5, direction: ReadDirections.INBOX, stillUnreadCount: 3 });

  expect(database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(3);
  database.close();
});

// An inbox read says nothing about whether THEY have seen YOUR messages.
test('an inbox read leaves the outbox ticks alone', () => {
  const { adapter, emitReadReceipt } = buildAdapter();
  const { service, database } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 9, readOutboxMaxId: 4 });
  service.start();

  emitReadReceipt({ peerId: 'u1', maxId: 9, direction: ReadDirections.INBOX, stillUnreadCount: 0 });

  expect(database.listDialogs().find(dialog => dialog.peerId === 'u1')?.readOutboxMaxId).toBe(4);
  database.close();
});

// And the mirror: a receipt for your own messages must not silently clear a
// badge counting theirs.
test('an outbox receipt leaves the unread badge alone', () => {
  const { adapter, emitReadReceipt } = buildAdapter();
  const { service, database } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 9, readOutboxMaxId: 0 });
  service.start();

  emitReadReceipt({ peerId: 'u1', maxId: 9, direction: ReadDirections.OUTBOX, stillUnreadCount: null });

  expect(database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(7);
  database.close();
});

// Out-of-order inbox reads must not re-raise a badge that already cleared.
test('an inbox read older than one already applied does not resurrect the badge', () => {
  const { adapter, emitReadReceipt } = buildAdapter();
  const { service, database } = buildService(adapter);
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 9, readOutboxMaxId: 0 });
  service.start();

  emitReadReceipt({ peerId: 'u1', maxId: 9, direction: ReadDirections.INBOX, stillUnreadCount: 0 });
  emitReadReceipt({ peerId: 'u1', maxId: 4, direction: ReadDirections.INBOX, stillUnreadCount: 5 });

  expect(database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(0);
  database.close();
});

// ── live reactions ────────────────────────────────────────────────────────

/** A started service with its adapter to hand, which is what an emit needs. */
const buildHarness = (): {
  adapter: ReturnType<typeof buildAdapter>;
  database: DatabaseService;
  store: ApplicationStoreService;
} => {
  const adapter = buildAdapter();
  const { service, database, store } = buildService(adapter.adapter);
  service.start();
  return { adapter, database, store };
};

// Reported: the tally only moved when you touched it. A reaction someone else
// adds arrives as an update, and without subscribing to it the count on screen
// was whatever it was when the chat was opened.
test('a reaction someone else adds lands in the open chat', async () => {
  const harness = buildHarness();
  harness.database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  harness.database.insertMessages({
    messages: [{ peerId: 'u1', id: 7, fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null }],
  });
  harness.store.setState({
    patch: { activePeerId: 'u1', messages: harness.database.listMessages({ peerId: 'u1', limit: 50 }) },
  });

  harness.adapter.emitReactions({
    peerId: 'u1', messageId: 7, reactions: [{ emoji: '👍', count: 2, chosen: false }],
  });

  expect(harness.store.getState().messages[0]!.reactions).toEqual([{ emoji: '👍', count: 2, chosen: false }]);
  harness.database.close();
});

// Telegram sends the whole set every time, so a message whose last reaction
// was removed arrives with an empty list rather than not arriving.
test('the last reaction being removed clears the tally', async () => {
  const harness = buildHarness();
  harness.database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  harness.database.insertMessages({
    messages: [{
      peerId: 'u1', id: 7, fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null,
      reactions: [{ emoji: '👍', count: 1, chosen: false }],
    }],
  });
  harness.store.setState({
    patch: { activePeerId: 'u1', messages: harness.database.listMessages({ peerId: 'u1', limit: 50 }) },
  });

  harness.adapter.emitReactions({ peerId: 'u1', messageId: 7, reactions: [] });

  expect(harness.store.getState().messages[0]!.reactions).toEqual([]);
  harness.database.close();
});

// A reaction in some other conversation still belongs in the cache -- it will
// be right when that chat is opened -- but redrawing the one on screen for it
// would be redrawing something that has not changed.
test('a reaction in another chat is cached without touching the open one', async () => {
  const harness = buildHarness();
  for (const id of ['u1', 'u2']) {
    harness.database.upsertPeer({ id, type: 'user', accessHash: 'h', title: id, username: null });
  }
  harness.database.insertMessages({
    messages: [
      { peerId: 'u1', id: 7, fromId: 'u1', date: 100, text: 'here', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u2', id: 9, fromId: 'u2', date: 100, text: 'there', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  const shown = harness.database.listMessages({ peerId: 'u1', limit: 50 });
  harness.store.setState({ patch: { activePeerId: 'u1', messages: shown } });

  harness.adapter.emitReactions({
    peerId: 'u2', messageId: 9, reactions: [{ emoji: '🎉', count: 1, chosen: false }],
  });

  expect(harness.store.getState().messages).toBe(shown);
  expect(harness.database.listMessages({ peerId: 'u2', limit: 50 })[0]!.reactions)
    .toEqual([{ emoji: '🎉', count: 1, chosen: false }]);
  harness.database.close();
});
