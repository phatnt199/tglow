import { test, expect } from 'bun:test';

import { Api } from 'telegram';

import { ApplicationStoreService } from '../../core/application-store.ts';
import { DatabaseService } from '../../core/cache/index.ts';
import {
  DifferenceService,
  type IDifferenceAdapter,
  type IDifferenceResult,
  type IUpdateState,
} from '../../core/difference-service.ts';
import type { IMessageAdapter, IRawMessage } from '../../core/message-service.ts';
import { buildDifferenceAdapter } from '../../core/telegram-adapter.ts';
import { UpdateService } from '../../core/update-service.ts';

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
  /** The state each getDifference call was made from -- empty when catch-up never fetched. */
  fetched: IUpdateState[];
}

const build = (overrides: Partial<IDifferenceAdapter> = {}): IHarness => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h1', title: 'Alice', username: null });
  const store = new ApplicationStoreService();

  const applied: IRawMessage[] = [];
  const fetched: IUpdateState[] = [];

  // A real UpdateService, not a stand-in: "a backfilled message and a live one
  // are indistinguishable" is the property under test, and a fake apply() would
  // assert nothing about it. Its message adapter is never touched -- catchUp
  // calls apply() directly, and only start() ever subscribes.
  const updateService = new UpdateService({} as IMessageAdapter, database, store);
  const apply = updateService.apply;
  updateService.apply = (message: IRawMessage): boolean => {
    applied.push(message);
    return apply(message);
  };

  const adapter: IDifferenceAdapter = {
    getState: overrides.getState ?? (async (): Promise<IUpdateState> => SERVER_STATE),
    getDifference: async (differenceOpts: { state: IUpdateState }): Promise<IDifferenceResult> => {
      fetched.push(differenceOpts.state);
      if (!overrides.getDifference) {
        return { messages: [], state: differenceOpts.state, isTooLong: false };
      }
      return overrides.getDifference(differenceOpts);
    },
  };

  return {
    service: new DifferenceService(adapter, database, store, updateService),
    database,
    store,
    applied,
    fetched,
  };
};

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
  expect(harness.store.getState().statusMessage).toContain('history');
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
