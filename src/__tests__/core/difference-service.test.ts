import { test, expect } from 'bun:test';

import { Api } from 'teleproto';

import { ApplicationStoreService } from '../../core/application-store.ts';
import { DatabaseService } from '../../core/cache/index.ts';
import { DifferenceService, type IChannelDifferenceResult, type IDifferenceAdapter, type IDifferenceResult } from '../../core/difference-service.ts';
import { MessageService, type ILiveMessage, type IMessageAdapter, type IRawMessage } from '../../core/message-service.ts';
import { buildDifferenceAdapter } from '../../core/telegram-adapter.ts';
import type { IUpdateState } from '../../core/update-state.ts';
import type { IMessageReaction } from '../../core/reactions.ts';
import { MessageOrigins, UpdateService, type TMessageOrigin } from '../../core/update-service.ts';

const buildRawMessage = (overrides: Partial<IRawMessage> = {}): IRawMessage => ({
  id: 1, peerId: 'u1', fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null, ...overrides,
});

const SERVER_STATE: IUpdateState = { pts: 100, qts: 0, date: 5, seq: 1 };

interface IHarness {
  service: DifferenceService;
  database: DatabaseService;
  store: ApplicationStoreService;
  /** Every message handed to UpdateService.apply, in the order catch-up handed it over. */
  applied: IRawMessage[];
  /** The origin catch-up declared for each applied message -- backfill, never live. */
  origins: TMessageOrigin[];
  /** The state each getDifference call was made from -- empty when catch-up never fetched. */
  fetched: IUpdateState[];
  /** Every (peerId, limit) the too-long recovery re-fetched history for. */
  refetched: Array<{ peerId: string; limit: number }>;
  /** Drives the real UpdateService's live subscription, exactly as GramJS would. */
  emitLive: (live: ILiveMessage) => void;
  /** The same adapter DifferenceService re-fetches through, so a test can hand it to a real MessageService. */
  messageAdapter: IMessageAdapter;
  /** Every (peerId, pts) a channel difference was asked for, in order. */
  channelDifferences: Array<{ peerId: string; pts: number }>;
}

const build = (
  overrides: Partial<IDifferenceAdapter> & { history?: (opts: { peerId: string }) => IRawMessage[] } = {},
): IHarness => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h1', title: 'Alice', username: null });
  const store = new ApplicationStoreService();

  const applied: IRawMessage[] = [];
  const origins: TMessageOrigin[] = [];
  const fetched: IUpdateState[] = [];
  const refetched: Array<{ peerId: string; limit: number }> = [];

  let onMessage: ((live: ILiveMessage) => void) | null = null;
  const messageAdapter = {
    fetchHistory: async (historyOpts: { peerId: string; limit: number }): Promise<IRawMessage[]> => {
      refetched.push(historyOpts);
      return overrides.history?.({ peerId: historyOpts.peerId }) ?? [];
    },
    subscribeToNewMessages: (subscribeOpts: { onMessage: (live: ILiveMessage) => void }): (() => void) => {
      onMessage = subscribeOpts.onMessage;
      return (): void => { onMessage = null; };
    },
    // Never fired here -- this file is about catch-up, not receipts -- but
    // UpdateService.start() calls it, so a stub is the difference between this
    // suite running and throwing on the first build().
    subscribeToReadReceipts: (): (() => void) => (): void => {},
    subscribeToPresence: (): (() => void) => (): void => {},
    subscribeToReactions: (): (() => void) => (): void => {},
    downloadThumbnail: async (): Promise<Uint8Array | null> => null,
    downloadMedia: async (): Promise<Uint8Array | null> => null,
    subscribeToTyping: (): (() => void) => (): void => {},
    // Stubs for the rest of IMessageAdapter. They exist so this fake can be
    // typed rather than cast: the previous `as IMessageAdapter` hid the fact
    // that UpdateService.start() had begun calling a member this object did
    // not have, which tsc could not see and every test in the file hit as a
    // TypeError. Typed, the compiler names the gap instead.
    send: async (): Promise<IRawMessage> => { throw new Error('send is not exercised by difference-service tests'); },
    edit: async (): Promise<IRawMessage> => { throw new Error('edit is not exercised by difference-service tests'); },
    delete: async (): Promise<void> => {},
    markRead: async (): Promise<void> => {},
    pinMessage: async (): Promise<void> => {},
  react: async (): Promise<IMessageReaction[]> => [],
  forward: async (): Promise<void> => {},
  sendFile: async (opts): Promise<IRawMessage> => buildRawMessage({ id: 98, peerId: opts.peerId, text: opts.caption, out: 1 }),
  } satisfies IMessageAdapter;

  // A real UpdateService, not a stand-in: "a backfilled message and a live one
  // are indistinguishable" is the property under test, and a fake apply() would
  // assert nothing about it.
  const updateService = new UpdateService(messageAdapter, database, store);
  const apply = updateService.apply;
  updateService.apply = (applyOpts: { message: IRawMessage; origin: TMessageOrigin }): boolean => {
    applied.push(applyOpts.message);
    origins.push(applyOpts.origin);
    return apply(applyOpts);
  };
  updateService.start();
  const channelDifferences: Array<{ peerId: string; pts: number }> = [];

  const adapter: IDifferenceAdapter = {
    getState: overrides.getState ?? (async (): Promise<IUpdateState> => SERVER_STATE),
    getChannelDifference: overrides.getChannelDifference
      ?? (async (channelOpts: { peerId: string; pts: number }): Promise<IChannelDifferenceResult> => {
        channelDifferences.push(channelOpts);
        return { messages: [], pts: channelOpts.pts, final: true, tooLong: false };
      }),
    getDifference: async (differenceOpts: { state: IUpdateState }): Promise<IDifferenceResult> => {
      fetched.push(differenceOpts.state);
      if (!overrides.getDifference) {
        return { messages: [], state: differenceOpts.state, isTooLong: false };
      }
      return overrides.getDifference(differenceOpts);
    },
  };

  return {
    service: new DifferenceService(adapter, messageAdapter, database, store, updateService),
    database,
    store,
    applied,
    origins,
    fetched,
    refetched,
    emitLive: (live: ILiveMessage): void => { onMessage?.(live); },
    messageAdapter,
    channelDifferences,
  };
};

/**
 * Critical 1, the badge half. dialogService.sync() has already written the
 * server's own authoritative unreadCount before catchUp ever runs (main.ts's
 * order), and that count already includes every message the difference is
 * about to replay -- so counting them again inflates the badge on every
 * launch, permanently, since nothing but a later sync ever writes it back
 * down. Drop the origin argument from touchDialog and this is what fails.
 */
test('a backfilled message does not raise a dialog unread count the server already counted', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, peerId: 'u1', text: 'already counted' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  // What dialogService.sync() wrote from the server a moment earlier.
  harness.database.upsertDialog({
    peerId: 'u1', pinned: 0, unreadCount: 5, lastMessageAt: 100, topMessageId: 1, readOutboxMaxId: 0, readInboxMaxId: 0,
  });

  await harness.service.catchUp();

  expect(harness.database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(5);
  // Still applied, still cached, still the top message -- only the count is left alone.
  expect(harness.database.listDialogs().find(dialog => dialog.peerId === 'u1')?.topMessageId).toBe(2);
  harness.database.close();
});

test('catch-up declares every message it applies a backfill, never a live arrival', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, peerId: 'u1' }), buildRawMessage({ id: 3, peerId: 'u1' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });

  await harness.service.catchUp();

  expect(harness.origins).toEqual([MessageOrigins.BACKFILL, MessageOrigins.BACKFILL]);
  harness.database.close();
});

/**
 * Critical 1, the pts half -- and the reason the badge bug was permanent
 * rather than self-correcting. pts was written only here, by a method that
 * runs once at startup, so it never moved during a session and the next
 * launch's difference re-delivered everything the previous session had
 * already received, read and acked. The live path has to persist the state
 * it consumes.
 */
test('a second catch-up after live traffic resumes from the live pts, re-delivering nothing', async () => {
  const harness = build({
    getDifference: async (differenceOpts: { state: IUpdateState }) => {
      // The server only ever offers what is actually after the requested pts.
      if (differenceOpts.state.pts < 120) {
        return {
          messages: [buildRawMessage({ id: 2, peerId: 'u1', text: 'while closed' })],
          state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
        };
      }
      return { messages: [], state: differenceOpts.state, isTooLong: false };
    },
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });

  await harness.service.catchUp();
  expect(harness.database.getSyncState({ key: 'pts' })).toBe(120);

  // A session's worth of live traffic, each update carrying its own pts.
  harness.emitLive({ message: buildRawMessage({ id: 3, peerId: 'u1', date: 300, text: 'live one' }), pts: 121, channelPts: null });
  harness.emitLive({ message: buildRawMessage({ id: 4, peerId: 'u1', date: 400, text: 'live two' }), pts: 122, channelPts: null });

  expect(harness.database.getSyncState({ key: 'pts' })).toBe(122);

  await harness.service.catchUp();

  // The second request starts from what the live path consumed, not from where
  // the first catch-up stopped -- otherwise every launch replays the session
  // before it.
  expect(harness.fetched.map(state => state.pts)).toEqual([100, 122]);
  // `applied` sees the live path too (it wraps apply itself), so the claim is
  // about what catch-up backfilled: message 2 once, and never again.
  const backfilled = harness.applied.filter((unused, index) => harness.origins[index] === MessageOrigins.BACKFILL);
  expect(backfilled.map(message => message.id)).toEqual([2]);
  harness.database.close();
});

test('a live update with no common pts leaves the stored state where it was', async () => {
  const harness = build();
  harness.database.setSyncState({ key: 'pts', value: 100 });

  // A channel update's pts belongs to that channel's own sequence; writing it
  // into the account-wide row would send the next difference somewhere the
  // server cannot follow. The adapter reports null rather than guessing.
  harness.emitLive({ message: buildRawMessage({ id: 3, peerId: 'u1', date: 300 }), pts: null, channelPts: null });

  expect(harness.database.getSyncState({ key: 'pts' })).toBe(100);
  harness.database.close();
});

test('a live pts behind the stored one never rewinds the stored state', async () => {
  const harness = build();
  harness.database.setSyncState({ key: 'pts', value: 500 });

  harness.emitLive({ message: buildRawMessage({ id: 3, peerId: 'u1', date: 300 }), pts: 400, channelPts: null });

  expect(harness.database.getSyncState({ key: 'pts' })).toBe(500);
  harness.database.close();
});

/**
 * The same invariant catchUp holds for a backfill, on the live path: a message
 * the cache refused leaves the stored pts alone, so the next launch's
 * difference still covers it. 'ghost' has no peers row, so the FK rejects it.
 */
test('a live message that could not be cached does not advance the stored pts', async () => {
  const harness = build();
  harness.database.setSyncState({ key: 'pts', value: 100 });

  harness.emitLive({ message: buildRawMessage({ id: 3, peerId: 'ghost', date: 300 }), pts: 130, channelPts: null });

  expect(harness.database.getSyncState({ key: 'pts' })).toBe(100);
  harness.database.close();
});

test('a live update before any stored state exists does not invent one', async () => {
  const harness = build();

  harness.emitLive({ message: buildRawMessage({ id: 3, peerId: 'u1', date: 300 }), pts: 130, channelPts: null });

  // Claiming pts 130 would assert everything below it had been consumed, when
  // catch-up has not run at all -- the first run's own getState is the only
  // thing entitled to establish that baseline.
  expect(harness.database.getSyncState({ key: 'pts' })).toBeNull();
  harness.database.close();
});

test('a first run with no stored state stores the server state and fetches nothing', async () => {
  const harness = build({ getState: async () => ({ pts: 100, qts: 0, date: 5, seq: 1 }) });
  await harness.service.catchUp();
  expect(harness.database.getSyncState({ key: 'pts' })).toBe(100);
  expect(harness.fetched).toEqual([]);
  harness.database.close();
});

test('a later run fetches the difference from the stored pts and applies the messages', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, text: 'missed you' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 },
      isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await harness.service.catchUp();
  expect(harness.applied.map(message => message.text)).toEqual(['missed you']);
  expect(harness.database.getSyncState({ key: 'pts' })).toBe(120);
  harness.database.close();
});

test('backfilled messages go through the same path as live ones', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, peerId: 'u1', text: 'missed' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await harness.service.catchUp();
  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toContain('missed');
  harness.database.close();
});

// Reconciling a too-long difference is where clients lose messages quietly.
test('differenceTooLong stores the new state and does not pretend to have caught up', async () => {
  const harness = build({
    getDifference: async () => ({ messages: [], state: { pts: 900, qts: 0, date: 9, seq: 2 }, isTooLong: true }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await harness.service.catchUp();
  expect(harness.database.getSyncState({ key: 'pts' })).toBe(900);
  expect(harness.store.getState().integrityWarning).toContain('history');
  harness.database.close();
});

// --- Critical 3: differenceTooLong must re-fetch, not jump ------------------
//
// Spec §3.4: "If the server replies differenceTooLong, drop cached state for
// that peer and re-fetch history rather than trying to reconcile." Storing the
// server's new pts alone advances the account past a range of messages that
// were never sent -- and a difference only ever runs forward, so nothing will
// ever offer them again.

const buildTooLongHarness = (history: (opts: { peerId: string }) => IRawMessage[]): IHarness => {
  const harness = build({
    getDifference: async () => ({ messages: [], state: { pts: 900, qts: 0, date: 9, seq: 2 }, isTooLong: true }),
    history,
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  // What dialogService.sync() left behind: the chats whose history the pts
  // jump has just made untrustworthy.
  harness.database.upsertPeer({ id: 'u2', type: 'user', accessHash: 'h2', title: 'Bob', username: null });
  harness.database.upsertDialog({
    peerId: 'u1', pinned: 0, unreadCount: 3, lastMessageAt: 200, topMessageId: 9, readOutboxMaxId: 0, readInboxMaxId: 0,
  });
  harness.database.upsertDialog({
    peerId: 'u2', pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 4, readOutboxMaxId: 0, readInboxMaxId: 0,
  });
  return harness;
};

test('differenceTooLong re-fetches each cached chat history from the server', async () => {
  const harness = buildTooLongHarness(() => []);

  await harness.service.catchUp();

  expect(harness.refetched.map(request => request.peerId)).toEqual(['u1', 'u2']);
  harness.database.close();
});

test('the messages a too-long re-fetch recovers are written to the cache', async () => {
  const harness = buildTooLongHarness(({ peerId }) =>
    peerId === 'u1' ? [buildRawMessage({ id: 7, peerId: 'u1', text: 'inside the gap' })] : []);

  await harness.service.catchUp();

  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toContain('inside the gap');
  harness.database.close();
});

// The recovery must not become the next bug: re-fetched history is history the
// server's own unreadCount already accounts for.
test('a too-long re-fetch does not touch the unread counts sync just wrote', async () => {
  const harness = buildTooLongHarness(({ peerId }) =>
    peerId === 'u1' ? [buildRawMessage({ id: 7, peerId: 'u1', text: 'inside the gap' })] : []);

  await harness.service.catchUp();

  expect(harness.database.listDialogs().find(dialog => dialog.peerId === 'u1')?.unreadCount).toBe(3);
  harness.database.close();
});

/**
 * Why it terminates. Refusing to store the new state would leave the next
 * getDifference asking from the same pts the server has already refused to
 * enumerate -- the same too-long answer, every launch, forever. The state is
 * stored, so the next request starts from somewhere the server can serve;
 * re-fetching history is what covers the range the jump skipped.
 */
test('differenceTooLong stores the new state even when the re-fetch fails, so it cannot loop', async () => {
  const harness = buildTooLongHarness(() => { throw new Error('offline'); });

  await expect(harness.service.catchUp()).resolves.toBeUndefined();

  expect(harness.database.getSyncState({ key: 'pts' })).toBe(900);
  expect(harness.store.getState().integrityWarning).toContain('history');
  harness.database.close();
});

test('one chat failing to re-fetch does not stop the others', async () => {
  const harness = buildTooLongHarness(({ peerId }) => {
    if (peerId === 'u1') {
      throw new Error('offline');
    }
    return [buildRawMessage({ id: 8, peerId: 'u2', text: 'second chat recovered' })];
  });
  harness.database.upsertPeer({ id: 'u2', type: 'user', accessHash: 'h2', title: 'Bob', username: null });

  await harness.service.catchUp();

  expect(harness.refetched.map(request => request.peerId)).toEqual(['u1', 'u2']);
  expect(harness.database.listMessages({ peerId: 'u2', limit: 10 }).map(row => row.text))
    .toContain('second chat recovered');
  harness.database.close();
});

// An ordinary, enumerable difference has nothing to recover -- every message in
// it was actually delivered, so a sweep of history fetches would be pure cost.
test('a difference that is not too long re-fetches nothing', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, peerId: 'u1' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });

  await harness.service.catchUp();

  expect(harness.refetched).toEqual([]);
  harness.database.close();
});

/**
 * Critical 2, reproduced end to end against main.ts's real order:
 * dialogService.sync(), catchUp(), then loadHistory() for the first chat. The
 * warning was written to statusMessage, and loadHistory's success patch sets
 * statusMessage to null unconditionally -- so the one message that says
 * messages were lost was erased before the first frame, every launch. Put the
 * warning back on statusMessage and this is the test that fails.
 */
test('a catch-up integrity warning survives the loadHistory main.ts runs straight after it', async () => {
  const harness = build({
    getDifference: async () => ({ messages: [], state: { pts: 900, qts: 0, date: 9, seq: 2 }, isTooLong: true }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });

  await harness.service.catchUp();
  expect(harness.store.getState().integrityWarning).toContain('history');

  const messageService = new MessageService(harness.messageAdapter, harness.database, harness.store);
  await messageService.loadHistory({ peerId: 'u1', limit: 50 });

  expect(harness.store.getState().statusMessage).toBeNull();
  expect(harness.store.getState().integrityWarning).toContain('history');
  harness.database.close();
});

// Critical 2: the warning that means messages were lost goes somewhere
// loadHistory's unconditional `statusMessage: null` cannot reach.
test('the could-not-save warning is written to integrityWarning, not statusMessage', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, peerId: 'ghost', text: 'lost' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });

  await harness.service.catchUp();

  expect(harness.store.getState().integrityWarning).toContain('could not be saved');
  expect(harness.store.getState().statusMessage).toBeNull();
  harness.database.close();
});

test('a failing adapter is logged and leaves the stored state untouched', async () => {
  const harness = build({ getDifference: async () => { throw new Error('offline'); } });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await expect(harness.service.catchUp()).resolves.toBeUndefined();
  expect(harness.database.getSyncState({ key: 'pts' })).toBe(100);
  harness.database.close();
});

test('catchUp applies messages in id order', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 3, text: 'third' }), buildRawMessage({ id: 2, text: 'second' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await harness.service.catchUp();
  expect(harness.applied.map(message => message.id)).toEqual([2, 3]);
  harness.database.close();
});

/**
 * The invariant the whole task turns on, and the one no other test can catch:
 * advancing pts past a message that never landed loses it permanently, because
 * the next catch-up starts *after* it and the server will never offer it again.
 * 'ghost' was never upserted as a peer, so the FK from messages.peer_id to
 * peers.id rejects the cache write -- the same failure mode update-service.test
 * uses, reached here through catchUp instead of a live event. Move the
 * setSyncState call above the apply loop, or drop apply()'s return value, and
 * this is what fails.
 */
test('a message that could not be applied leaves the stored state untouched', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, peerId: 'ghost', text: 'lost' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });

  await expect(harness.service.catchUp()).resolves.toBeUndefined();

  expect(harness.database.getSyncState({ key: 'pts' })).toBe(100);
  harness.database.close();
});

test('the messages that did land are still cached when a later one fails to apply', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, peerId: 'u1', text: 'landed' }), buildRawMessage({ id: 3, peerId: 'ghost' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });

  await harness.service.catchUp();

  // Re-applied from the same pts on the next run, and insertMessages upserts on
  // (peerId, id) -- a duplicate write is free, a skipped message is not.
  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toEqual(['landed']);
  harness.database.close();
});

test('qts, date and seq are stored alongside pts, and read back into the next fetch', async () => {
  const harness = build({
    getDifference: async () => ({ messages: [], state: { pts: 120, qts: 7, date: 9, seq: 2 }, isTooLong: false }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  harness.database.setSyncState({ key: 'qts', value: 3 });
  harness.database.setSyncState({ key: 'date', value: 5 });
  harness.database.setSyncState({ key: 'seq', value: 1 });

  await harness.service.catchUp();

  expect(harness.fetched).toEqual([{ pts: 100, qts: 3, date: 5, seq: 1 }]);
  expect(harness.database.getSyncState({ key: 'qts' })).toBe(7);
  expect(harness.database.getSyncState({ key: 'date' })).toBe(9);
  expect(harness.database.getSyncState({ key: 'seq' })).toBe(2);
  harness.database.close();
});

test('a first run whose getState fails stores nothing and still resolves', async () => {
  const harness = build({ getState: async () => { throw new Error('offline'); } });

  await expect(harness.service.catchUp()).resolves.toBeUndefined();

  expect(harness.database.getSyncState({ key: 'pts' })).toBeNull();
  expect(harness.fetched).toEqual([]);
  harness.database.close();
});

test('a backfilled message reaches the store for the active chat, exactly as a live one does', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, peerId: 'u1', text: 'while you were out' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  harness.store.setState({ patch: { activePeerId: 'u1', messages: [], messageCursor: 0 } });

  await harness.service.catchUp();

  expect(harness.store.getState().messages.map(message => message.text)).toEqual(['while you were out']);
  harness.database.close();
});

// --- buildDifferenceAdapter: the four result classes GramJS can return -------
//
// Real Api.* instances, not hand-rolled objects: the className strings and the
// field names are the whole risk here (updates.difference carries `state`,
// updates.differenceSlice carries `intermediateState`, updates.differenceEmpty
// carries neither pts nor qts, and updates.differenceTooLong carries only pts),
// and only the library's own constructors can prove tglow read them right.

const buildPeerMessage = (opts: { id: number; text: string }): Api.Message => {
  return new Api.Message({
    id: opts.id,
    peerId: new Api.PeerUser({ userId: BigInt(1) as any }),
    date: 100 + opts.id,
    message: opts.text,
  });
};

const buildState = (opts: { pts: number; qts: number; date: number; seq: number }): Api.updates.State => {
  return new Api.updates.State({ ...opts, unreadCount: 0 });
};

const buildClient = (opts: { responses: unknown[] }): { client: any; requests: any[] } => {
  const requests: any[] = [];
  const queue = [...opts.responses];
  return {
    client: {
      invoke: async (request: unknown): Promise<unknown> => {
        requests.push(request);
        return queue.shift();
      },
    },
    requests,
  };
};

test('the adapter reads updates.getState into an IUpdateState', async () => {
  const { client, requests } = buildClient({ responses: [buildState({ pts: 42, qts: 7, date: 5, seq: 1 })] });
  const adapter = buildDifferenceAdapter({ client });

  expect(await adapter.getState()).toEqual({ pts: 42, qts: 7, date: 5, seq: 1 });
  expect(requests[0].className).toBe('updates.GetState');
});

test('updates.difference yields its messages and its final state', async () => {
  const { client, requests } = buildClient({
    responses: [
      new Api.updates.Difference({
        newMessages: [buildPeerMessage({ id: 2, text: 'missed you' })],
        newEncryptedMessages: [],
        otherUpdates: [],
        chats: [],
        users: [],
        state: buildState({ pts: 120, qts: 0, date: 9, seq: 2 }),
      }),
    ],
  });

  const result = await buildDifferenceAdapter({ client }).getDifference({
    state: { pts: 100, qts: 0, date: 5, seq: 1 },
  });

  expect(result.messages.map(message => message.text)).toEqual(['missed you']);
  expect(result.state).toEqual({ pts: 120, qts: 0, date: 9, seq: 2 });
  expect(result.isTooLong).toBe(false);
  expect(requests[0].pts).toBe(100);
  expect(requests[0].date).toBe(5);
  expect(requests[0].qts).toBe(0);
});

test('a service message in updates.difference is dropped rather than cached as an empty message', async () => {
  const { client } = buildClient({
    responses: [
      new Api.updates.Difference({
        newMessages: [
          buildPeerMessage({ id: 2, text: 'real' }),
          new Api.MessageService({
            id: 3,
            peerId: new Api.PeerUser({ userId: BigInt(1) as any }),
            date: 103,
            action: new Api.MessageActionHistoryClear(),
          }),
        ],
        newEncryptedMessages: [],
        otherUpdates: [],
        chats: [],
        users: [],
        state: buildState({ pts: 120, qts: 0, date: 9, seq: 2 }),
      }),
    ],
  });

  const result = await buildDifferenceAdapter({ client }).getDifference({
    state: { pts: 100, qts: 0, date: 5, seq: 1 },
  });

  expect(result.messages.map(message => message.id)).toEqual([2]);
});

// The case that silently truncates a backfill: a slice means "there is more".
test('updates.differenceSlice is followed from its intermediateState until a terminal result', async () => {
  const { client, requests } = buildClient({
    responses: [
      new Api.updates.DifferenceSlice({
        newMessages: [buildPeerMessage({ id: 2, text: 'first half' })],
        newEncryptedMessages: [],
        otherUpdates: [],
        chats: [],
        users: [],
        intermediateState: buildState({ pts: 110, qts: 4, date: 7, seq: 2 }),
      }),
      new Api.updates.Difference({
        newMessages: [buildPeerMessage({ id: 3, text: 'second half' })],
        newEncryptedMessages: [],
        otherUpdates: [],
        chats: [],
        users: [],
        state: buildState({ pts: 120, qts: 5, date: 9, seq: 3 }),
      }),
    ],
  });

  const result = await buildDifferenceAdapter({ client }).getDifference({
    state: { pts: 100, qts: 0, date: 5, seq: 1 },
  });

  expect(result.messages.map(message => message.text)).toEqual(['first half', 'second half']);
  expect(result.state).toEqual({ pts: 120, qts: 5, date: 9, seq: 3 });
  expect(result.isTooLong).toBe(false);
  // The second call resumes from the slice's intermediateState, not from the
  // state the caller started with -- resending the original pts would loop on
  // the same slice forever.
  expect(requests.map(request => request.pts)).toEqual([100, 110]);
  expect(requests.map(request => request.qts)).toEqual([0, 4]);
});

test('updates.differenceEmpty carries only date and seq, so pts and qts survive it', async () => {
  const { client } = buildClient({ responses: [new Api.updates.DifferenceEmpty({ date: 11, seq: 3 })] });

  const result = await buildDifferenceAdapter({ client }).getDifference({
    state: { pts: 100, qts: 4, date: 5, seq: 1 },
  });

  expect(result.messages).toEqual([]);
  expect(result.state).toEqual({ pts: 100, qts: 4, date: 11, seq: 3 });
  expect(result.isTooLong).toBe(false);
});

test('updates.differenceTooLong carries only pts, and is reported as too long', async () => {
  const { client } = buildClient({ responses: [new Api.updates.DifferenceTooLong({ pts: 900 })] });

  const result = await buildDifferenceAdapter({ client }).getDifference({
    state: { pts: 100, qts: 4, date: 5, seq: 1 },
  });

  expect(result.state).toEqual({ pts: 900, qts: 4, date: 5, seq: 1 });
  expect(result.isTooLong).toBe(true);
});

test('a slice followed by too-long keeps the messages already collected', async () => {
  const { client } = buildClient({
    responses: [
      new Api.updates.DifferenceSlice({
        newMessages: [buildPeerMessage({ id: 2, text: 'collected' })],
        newEncryptedMessages: [],
        otherUpdates: [],
        chats: [],
        users: [],
        intermediateState: buildState({ pts: 110, qts: 4, date: 7, seq: 2 }),
      }),
      new Api.updates.DifferenceTooLong({ pts: 900 }),
    ],
  });

  const result = await buildDifferenceAdapter({ client }).getDifference({
    state: { pts: 100, qts: 0, date: 5, seq: 1 },
  });

  expect(result.messages.map(message => message.text)).toEqual(['collected']);
  // qts/date/seq come from the last intermediateState, not from the caller's
  // original state -- too-long replaces pts and nothing else.
  expect(result.state).toEqual({ pts: 900, qts: 4, date: 7, seq: 2 });
  expect(result.isTooLong).toBe(true);
});

test('an endless run of slices stops at the cap and reports how far it actually got', async () => {
  const responses = Array.from({ length: 200 }, (unused, index) =>
    new Api.updates.DifferenceSlice({
      newMessages: [buildPeerMessage({ id: index + 2, text: `slice ${index}` })],
      newEncryptedMessages: [],
      otherUpdates: [],
      chats: [],
      users: [],
      intermediateState: buildState({ pts: 101 + index, qts: 0, date: 5, seq: 1 }),
    }),
  );
  const { client, requests } = buildClient({ responses });

  const result = await buildDifferenceAdapter({ client }).getDifference({
    state: { pts: 100, qts: 0, date: 5, seq: 1 },
  });

  expect(requests.length).toBeLessThan(200);
  // The state reported is the last intermediateState reached, so the next
  // catch-up resumes exactly where this one stopped instead of starting over.
  expect(result.state.pts).toBe(100 + requests.length);
  expect(result.messages).toHaveLength(requests.length);
});

// ── channels ──────────────────────────────────────────────────────────────

/** A cached channel with a pts already recorded, which is what makes it recoverable. */
const seedChannel = (harness: IHarness, opts: { peerId: string; pts: number | null }): void => {
  harness.database.upsertPeer({ id: opts.peerId, type: 'channel', accessHash: 'h', title: 'Channel', username: null });
  if (opts.pts !== null) {
    harness.database.setSyncState({ key: `channel_pts:${opts.peerId}`, value: opts.pts });
  }
};

// Channels are why getDifference alone was never enough: each numbers its own
// sequence, so the account-wide difference does not carry their messages at
// all and a channel was simply never backfilled.
test('a channel is recovered from its own pts', async () => {
  const harness = build({});
  seedChannel(harness, { peerId: 'c1', pts: 40 });

  await harness.service.catchUp();

  expect(harness.channelDifferences).toEqual([{ peerId: 'c1', pts: 40 }]);
});

// Without a stored pts there is no gap to reason about, and asking from zero
// would replay the channel's entire history.
test('a channel with no recorded pts is left alone', async () => {
  const harness = build({});
  seedChannel(harness, { peerId: 'c1', pts: null });

  await harness.service.catchUp();

  expect(harness.channelDifferences).toEqual([]);
});

// Only channels: an ordinary chat is already covered by the account-wide
// difference, and asking about it separately would be a wasted round trip.
test('ordinary chats are not asked for a channel difference', async () => {
  const harness = build({});
  harness.database.upsertPeer({ id: 'u9', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  harness.database.setSyncState({ key: 'channel_pts:u9', value: 12 });

  await harness.service.catchUp();

  expect(harness.channelDifferences).toEqual([]);
});

// A difference that comes back short of the gap has to be asked again from
// where it stopped, or the rest of it is simply never recovered.
test('a difference that is not final is asked again from where it stopped', async () => {
  const seen: number[] = [];
  const harness = build({
    getChannelDifference: async (opts: { peerId: string; pts: number }): Promise<IChannelDifferenceResult> => {
      seen.push(opts.pts);
      return seen.length < 3
        ? { messages: [], pts: opts.pts + 10, final: false, tooLong: false }
        : { messages: [], pts: opts.pts + 10, final: true, tooLong: false };
    },
  });
  seedChannel(harness, { peerId: 'c1', pts: 40 });

  await harness.service.catchUp();

  expect(seen).toEqual([40, 50, 60]);
});

// One channel failing must not stop the next: a partial recovery is strictly
// better than none.
test('one channel failing does not stop the others', async () => {
  const asked: string[] = [];
  const harness = build({
    getChannelDifference: async (opts: { peerId: string; pts: number }): Promise<IChannelDifferenceResult> => {
      asked.push(opts.peerId);
      if (opts.peerId === 'c1') {
        throw new Error('CHANNEL_PRIVATE');
      }
      return { messages: [], pts: opts.pts, final: true, tooLong: false };
    },
  });
  seedChannel(harness, { peerId: 'c1', pts: 10 });
  seedChannel(harness, { peerId: 'c2', pts: 20 });

  await harness.service.catchUp();

  expect(asked).toEqual(['c1', 'c2']);
});

// The pts only moves past what actually landed: a difference runs forward
// only, so advancing over a message the cache refused loses it permanently.
test('a channel pts advances only when every message landed', async () => {
  const harness = build({
    getChannelDifference: async (opts: { peerId: string; pts: number }): Promise<IChannelDifferenceResult> => ({
      messages: [buildRawMessage({ id: 5, peerId: opts.peerId })],
      pts: opts.pts + 5,
      final: true,
      tooLong: false,
    }),
  });
  seedChannel(harness, { peerId: 'c1', pts: 40 });

  await harness.service.catchUp();

  expect(harness.database.getSyncState({ key: 'channel_pts:c1' })).toBe(45);
});
