import { test, expect } from 'bun:test';

import { VimModes } from '../keys/common/index.ts';
import { ApplicationStoreService } from './application-store.ts';

test('starts with sensible defaults', () => {
  const store = new ApplicationStoreService();
  expect(store.getState().connection).toBe('offline');
  expect(store.getState().dialogs).toEqual([]);
  expect(store.getState().engine.mode).toBe(VimModes.NORMAL);
  expect(store.getState().activePeerId).toBeNull();
});

test('setState merges shallowly', () => {
  const store = new ApplicationStoreService();
  store.setState({ patch: { connection: 'connected' } });
  expect(store.getState().connection).toBe('connected');
  expect(store.getState().messages).toEqual([]);
});

test('subscribers are notified on every change', () => {
  const store = new ApplicationStoreService();
  let calls = 0;
  store.subscribe({ listener: () => { calls += 1; } });
  store.setState({ patch: { connection: 'connecting' } });
  store.setState({ patch: { statusMessage: 'hello' } });
  expect(calls).toBe(2);
});

test('unsubscribe stops notifications', () => {
  const store = new ApplicationStoreService();
  let calls = 0;
  const unsubscribe = store.subscribe({ listener: () => { calls += 1; } });
  store.setState({ patch: { connection: 'connecting' } });
  unsubscribe();
  store.setState({ patch: { connection: 'connected' } });
  expect(calls).toBe(1);
});

// React's useSyncExternalStore bails out unless the reference changes.
test('state is replaced, not mutated', () => {
  const store = new ApplicationStoreService();
  const before = store.getState();
  store.setState({ patch: { connection: 'connected' } });
  expect(store.getState()).not.toBe(before);
  expect(before.connection).toBe('offline');
});

test('one throwing subscriber does not stop the others', () => {
  const store = new ApplicationStoreService();
  let reached = false;
  store.subscribe({ listener: () => { throw new Error('boom'); } });
  store.subscribe({ listener: () => { reached = true; } });
  store.setState({ patch: { connection: 'connected' } });
  expect(reached).toBe(true);
});
