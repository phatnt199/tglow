import type { TConnectionState } from './application-store.ts';

/**
 * Noticing when the connection drops, so the status line can say so.
 *
 * Before this, `connection` was written exactly once -- to `'connected'`, at
 * startup -- and never again. teleproto reconnects on its own
 * (`autoReconnect: true`) and tells nobody, so a dropped network looked
 * identical to a quiet afternoon: the status line unchanged, messages simply
 * not arriving. In a chat client that is the worst possible failure, because
 * the user reads silence as "nobody wrote to me" and has no reason to doubt
 * it. Both `'connecting'` and `'offline'` already had glyphs in
 * status-segments.ts; neither could ever be reached.
 *
 * ## Why this reads a flag on a timer
 *
 * teleproto exposes `client.connected` as a getter and offers no event. This
 * is not the polling tglow avoids: that rule is about not asking *Telegram*
 * for updates it will push anyway, and this asks nothing of the network -- it
 * reads a boolean that already exists in this process. A few times a minute
 * costs nothing measurable and is the only signal available.
 */

/** How often to look. Fast enough to catch a drop while it still matters, slow enough to be free. */
export const CONNECTION_POLL_MILLISECONDS = 2_000;

/**
 * What a client's `connected` flag means for the status line.
 *
 * `undefined` is teleproto's "not established yet", which happens during a
 * reconnect as well as before the first connect -- and since `autoReconnect`
 * is on, a client that is not connected is one that is trying. That is
 * `'connecting'`, not `'offline'`: the difference matters, because `'offline'`
 * draws an alarm and reconnecting usually resolves itself in seconds.
 */
export const toConnectionState = (opts: { connected: boolean | undefined }): TConnectionState =>
  opts.connected === true ? 'connected' : 'connecting';

/**
 * Watch a connection and report every change, once.
 *
 * Only changes: patching the store on every tick would re-render the whole
 * interface a few times a minute for no reason.
 *
 * Returns the function that stops it.
 */
export const watchConnection = (opts: {
  read: () => boolean | undefined;
  onChange: (state: TConnectionState) => void;
  intervalMilliseconds?: number;
  /** Injected so tests do not need a real timer. */
  schedule?: (callback: () => void, milliseconds: number) => { cancel: () => void };
}): (() => void) => {
  let last: TConnectionState | null = null;

  const tick = (): void => {
    const next = toConnectionState({ connected: opts.read() });
    if (next !== last) {
      last = next;
      opts.onChange(next);
    }
  };

  // Once immediately, so the first state is published without waiting a whole
  // interval for it.
  tick();

  if (opts.schedule) {
    const handle = opts.schedule(tick, opts.intervalMilliseconds ?? CONNECTION_POLL_MILLISECONDS);
    return handle.cancel;
  }
  const timer = setInterval(tick, opts.intervalMilliseconds ?? CONNECTION_POLL_MILLISECONDS);
  // Never keeps the process alive on its own: quitting must not wait for a
  // timer whose only job is to colour one glyph.
  timer.unref?.();
  return (): void => { clearInterval(timer); };
};
