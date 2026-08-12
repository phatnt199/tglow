/**
 * Telegram's own errors, said in a way a person can act on.
 *
 * One of these matters far more than the rest. `FLOOD_WAIT_<n>` means the
 * account has been rate limited for n seconds, and until now tglow put the raw
 * string in the status line and did nothing else. That is the worst possible
 * handling, because the obvious response to "Send failed" is to press Enter
 * again -- and retrying inside the window is what extends it. The README has
 * admitted this since the first release.
 *
 * Third-party MTProto clients attract account restrictions by behaving
 * abnormally, and hammering a flood wait is exactly that. So the wait is
 * parsed, said in words, and enforced: the next attempt is refused locally,
 * before it reaches the network, until the window has passed.
 */

/** `FLOOD_WAIT_30`, `FLOOD_PREMIUM_WAIT_30`, and the same inside a longer message. */
const FLOOD_WAIT_PATTERN = /FLOOD(?:_PREMIUM)?_WAIT_(\d+)/;

/** Telegram is unhappy with the peer rather than with the rate. */
const FRIENDLY_MESSAGES: readonly { pattern: RegExp; text: string }[] = [
  { pattern: /^CHAT_WRITE_FORBIDDEN/, text: 'You cannot write in this chat' },
  { pattern: /^CHAT_SEND_MEDIA_FORBIDDEN/, text: 'Media is not allowed in this chat' },
  { pattern: /^USER_BANNED_IN_CHANNEL/, text: 'You are banned from this channel' },
  { pattern: /^MESSAGE_TOO_LONG/, text: 'That message is too long for Telegram' },
  { pattern: /^MESSAGE_NOT_MODIFIED/, text: 'The message is unchanged' },
  { pattern: /^MESSAGE_ID_INVALID/, text: 'That message is gone' },
  { pattern: /^MESSAGE_EDIT_TIME_EXPIRED/, text: 'That message is too old to edit' },
  { pattern: /^PEER_ID_INVALID/, text: 'Telegram does not recognise that chat' },
  { pattern: /^SLOWMODE_WAIT_(\d+)/, text: 'Slow mode is on in this chat' },
];

/** Seconds Telegram wants tglow to wait, or null when this is not a flood wait. */
export const parseFloodWaitSeconds = (opts: { message: string }): number | null => {
  const match = FLOOD_WAIT_PATTERN.exec(opts.message);
  if (!match) {
    return null;
  }
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

/** A duration a person reads without converting it. */
export const formatWait = (opts: { seconds: number }): string => {
  const SECONDS_PER_MINUTE = 60;
  const SECONDS_PER_HOUR = 3_600;
  if (opts.seconds < SECONDS_PER_MINUTE) {
    return `${Math.max(1, Math.ceil(opts.seconds))}s`;
  }
  if (opts.seconds < SECONDS_PER_HOUR) {
    return `${Math.ceil(opts.seconds / SECONDS_PER_MINUTE)}m`;
  }
  return `${Math.ceil(opts.seconds / SECONDS_PER_HOUR)}h`;
};

/**
 * What to put in the status line for a Telegram error.
 *
 * `action` names what failed ("Send", "Edit") so one helper serves every call
 * site without each inventing its own wording.
 */
export const describeTelegramError = (opts: { action: string; message: string }): string => {
  const seconds = parseFloodWaitSeconds({ message: opts.message });
  if (seconds !== null) {
    // Named as a rate limit rather than a failure, because the difference
    // decides what the user should do next: not "try again", which is what
    // makes it worse, but "wait".
    return `Rate limited by Telegram — wait ${formatWait({ seconds })} before trying again`;
  }

  const friendly = FRIENDLY_MESSAGES.find(entry => entry.pattern.test(opts.message));
  if (friendly) {
    return `${opts.action} failed: ${friendly.text.toLowerCase()}`;
  }
  return `${opts.action} failed: ${opts.message}`;
};

/**
 * When a peer may next be written to, kept per chat.
 *
 * A flood wait is the account's, not the chat's, but Telegram reports it in
 * response to one request and tglow only ever has the one it just made -- so
 * this is deliberately conservative: it blocks the chat that earned it and
 * leaves the rest alone, rather than pretending to know more than was said.
 */
export class FloodWaitRegistry {
  private readonly _until = new Map<string, number>();

  /** Record a wait, if the error was one. Returns the seconds recorded, or null. */
  record = (opts: { peerId: string; message: string; now: number }): number | null => {
    const seconds = parseFloodWaitSeconds({ message: opts.message });
    if (seconds === null) {
      return null;
    }
    this._until.set(opts.peerId, opts.now + seconds * 1_000);
    return seconds;
  };

  /** Seconds still to wait for this chat, or null when it is free. */
  remaining = (opts: { peerId: string; now: number }): number | null => {
    const until = this._until.get(opts.peerId);
    if (until === undefined) {
      return null;
    }
    if (opts.now >= until) {
      // Expired: forgotten rather than left to accumulate a row per chat ever
      // rate limited in the session.
      this._until.delete(opts.peerId);
      return null;
    }
    return (until - opts.now) / 1_000;
  };

  /** After a successful request, whatever was recorded is stale. */
  clear = (opts: { peerId: string }): void => {
    this._until.delete(opts.peerId);
  };
}
