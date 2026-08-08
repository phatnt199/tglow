/**
 * Whether someone is online, and when they were last seen.
 *
 * Telegram is deliberately vague here and tglow does not sharpen it. Someone
 * who hides their exact last-seen time is reported as "recently", "within a
 * week" or "within a month" and nothing more precise exists to show -- a
 * client that invented a time from those would be making it up.
 */
export class PresenceKinds {
  static readonly ONLINE = 'online';
  /** Offline, with a timestamp: the one case there is a real time to show. */
  static readonly OFFLINE = 'offline';
  static readonly RECENTLY = 'recently';
  static readonly LAST_WEEK = 'lastWeek';
  static readonly LAST_MONTH = 'lastMonth';
  /** Long ago, or hidden entirely. Telegram sends this for a user who has restricted it to nobody. */
  static readonly LONG_AGO = 'longAgo';
  /** Not a user: a group, a channel, or someone tglow has never seen a status for. */
  static readonly UNKNOWN = 'unknown';
}

export type TPresenceKind = (typeof PresenceKinds)[Exclude<keyof typeof PresenceKinds, 'prototype'>];

export interface IPresence {
  kind: TPresenceKind;
  /** Unix seconds. Only OFFLINE carries one; every other kind is vague by design. */
  seenAt: number | null;
}

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * "last seen 3 hours ago" is what a person wants; "last seen 187 minutes ago"
 * is the same fact, harder to read. Rounds down, so a thing that happened 119
 * minutes ago reads as an hour rather than two -- claiming more elapsed time
 * than has actually passed is the wrong direction to be wrong in.
 */
export const formatSince = (opts: { seconds: number }): string => {
  const { seconds } = opts;
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return 'just now';
  }
  if (seconds < SECONDS_PER_HOUR) {
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    return `${minutes}m ago`;
  }
  if (seconds < SECONDS_PER_DAY) {
    const hours = Math.floor(seconds / SECONDS_PER_HOUR);
    return `${hours}h ago`;
  }
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  return `${days}d ago`;
};

/**
 * One line naming someone's presence.
 *
 * `now` is passed rather than read, so this stays pure and so a test can ask
 * what a status looked like at a particular moment rather than at whatever
 * moment it happens to run.
 */
export const describePresence = (opts: { presence: IPresence; now: number }): string => {
  const { presence, now } = opts;
  switch (presence.kind) {
    case PresenceKinds.ONLINE: {
      return 'online';
    }
    case PresenceKinds.OFFLINE: {
      return presence.seenAt === null
        ? 'offline'
        : `last seen ${formatSince({ seconds: Math.max(0, now - presence.seenAt) })}`;
    }
    case PresenceKinds.RECENTLY: {
      return 'last seen recently';
    }
    case PresenceKinds.LAST_WEEK: {
      return 'last seen within a week';
    }
    case PresenceKinds.LAST_MONTH: {
      return 'last seen within a month';
    }
    case PresenceKinds.LONG_AGO: {
      return 'last seen a long time ago';
    }
    default: {
      return '';
    }
  }
};

/**
 * The one-column mark beside a name, or a blank.
 *
 * Only the certain case gets a mark. "Recently" is Telegram declining to say,
 * and a dot for it would read as a weaker version of online rather than as
 * "we are not being told" -- so the vague kinds show nothing here and say
 * what they mean in words instead.
 */
export const presenceMark = (opts: { presence: IPresence }): string =>
  opts.presence.kind === PresenceKinds.ONLINE ? '●' : ' ';
