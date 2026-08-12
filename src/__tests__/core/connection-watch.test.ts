import { test, expect } from 'bun:test';

import { toConnectionState, watchConnection } from '../../core/connection-watch.ts';

/** A timer under the test's control, so nothing here waits on a real clock. */
const manualSchedule = (): { schedule: (callback: () => void, ms: number) => { cancel: () => void }; tick: () => void; cancelled: () => boolean } => {
  let callback: (() => void) | null = null;
  let cancelled = false;
  return {
    schedule: (fn) => {
      callback = fn;
      return { cancel: () => { cancelled = true; } };
    },
    tick: () => { callback?.(); },
    cancelled: () => cancelled,
  };
};

// autoReconnect is on, so a client that is not connected is one that is
// trying. That is 'connecting', not 'offline' -- the difference matters,
// because 'offline' draws an alarm and a reconnect usually resolves itself.
test('connected is connected; anything else is connecting, not offline', () => {
  expect(toConnectionState({ connected: true })).toBe('connected');
  expect(toConnectionState({ connected: false })).toBe('connecting');
  expect(toConnectionState({ connected: undefined })).toBe('connecting');
});

// The first state must be published without waiting a whole interval for it.
test('the first reading is reported immediately', () => {
  const seen: string[] = [];
  const timer = manualSchedule();
  watchConnection({ read: () => true, onChange: state => seen.push(state), schedule: timer.schedule });

  expect(seen).toEqual(['connected']);
});

// The finding this exists for: the network drops and the status line looks
// exactly as it did, so the user reads silence as nobody having written.
test('a drop is reported', () => {
  const seen: string[] = [];
  let connected = true;
  const timer = manualSchedule();
  watchConnection({ read: () => connected, onChange: state => seen.push(state), schedule: timer.schedule });

  connected = false;
  timer.tick();

  expect(seen).toEqual(['connected', 'connecting']);
});

test('coming back is reported too', () => {
  const seen: string[] = [];
  let connected = false;
  const timer = manualSchedule();
  watchConnection({ read: () => connected, onChange: state => seen.push(state), schedule: timer.schedule });

  connected = true;
  timer.tick();

  expect(seen).toEqual(['connecting', 'connected']);
});

// Patching the store on every tick would re-render the whole interface a few
// times a minute to say nothing had changed.
test('an unchanged state is not reported again', () => {
  const seen: string[] = [];
  const timer = manualSchedule();
  watchConnection({ read: () => true, onChange: state => seen.push(state), schedule: timer.schedule });

  timer.tick();
  timer.tick();
  timer.tick();

  expect(seen).toEqual(['connected']);
});

test('stopping cancels the timer', () => {
  const timer = manualSchedule();
  const stop = watchConnection({ read: () => true, onChange: () => {}, schedule: timer.schedule });

  expect(timer.cancelled()).toBe(false);
  stop();
  expect(timer.cancelled()).toBe(true);
});

// A flapping connection must report each transition, not collapse them.
test('a flapping connection reports every transition', () => {
  const seen: string[] = [];
  let connected = true;
  const timer = manualSchedule();
  watchConnection({ read: () => connected, onChange: state => seen.push(state), schedule: timer.schedule });

  for (const next of [false, true, false]) {
    connected = next;
    timer.tick();
  }

  expect(seen).toEqual(['connected', 'connecting', 'connected', 'connecting']);
});
