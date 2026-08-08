/**
 * What a message carries besides text, and how to say so in one line.
 *
 * Until now a photo arrived as a message whose text was the empty string, and
 * the conversation drew a blank row for it. Not "a picture we cannot show" --
 * nothing at all, indistinguishable from an empty message, with no way to tell
 * that someone had sent you something.
 *
 * So: every media message says what it is, and says the one detail that makes
 * it identifiable -- a file's name, a voice message's length, a sticker's own
 * emoji. Drawing the actual pixels is a separate job; being able to see that
 * something is there is not, and it is the part that has been missing.
 */
export class MediaKinds {
  static readonly PHOTO = 'photo';
  static readonly VIDEO = 'video';
  static readonly VOICE = 'voice';
  static readonly AUDIO = 'audio';
  static readonly STICKER = 'sticker';
  static readonly ANIMATION = 'animation';
  static readonly DOCUMENT = 'document';
  static readonly LOCATION = 'location';
  static readonly CONTACT = 'contact';
  static readonly POLL = 'poll';
  /** Something this version of tglow does not know how to name. Telegram adds media types; a client that crashes on a new one is worse than one that says "unsupported". */
  static readonly UNSUPPORTED = 'unsupported';
}

export type TMediaKind = (typeof MediaKinds)[Exclude<keyof typeof MediaKinds, 'prototype'>];

export interface IMessageMedia {
  kind: TMediaKind;
  /** A file name, a song title, a contact's name, a poll's question -- whatever identifies this one. */
  title?: string;
  /** Seconds, for anything with a duration. */
  duration?: number;
  /** Bytes. */
  size?: number;
  width?: number;
  height?: number;
  /** The emoji a sticker stands for -- the closest thing to seeing it. */
  emoji?: string;
}

/**
 * The glyph each kind is announced with.
 *
 * Two columns each (they are emoji), which is fine here and would not be in
 * the rail: this is drawn in the content column, which wraps to whatever is
 * left of the pane rather than being a fixed-width field.
 */
const MEDIA_GLYPHS: Record<TMediaKind, string> = {
  [MediaKinds.PHOTO]: '📷',
  [MediaKinds.VIDEO]: '🎬',
  [MediaKinds.VOICE]: '🎤',
  [MediaKinds.AUDIO]: '🎵',
  [MediaKinds.STICKER]: '🙂',
  [MediaKinds.ANIMATION]: '🎞',
  [MediaKinds.DOCUMENT]: '📎',
  [MediaKinds.LOCATION]: '📍',
  [MediaKinds.CONTACT]: '👤',
  [MediaKinds.POLL]: '📊',
  [MediaKinds.UNSUPPORTED]: '❔',
};

const MEDIA_LABELS: Record<TMediaKind, string> = {
  [MediaKinds.PHOTO]: 'Photo',
  [MediaKinds.VIDEO]: 'Video',
  [MediaKinds.VOICE]: 'Voice',
  [MediaKinds.AUDIO]: 'Audio',
  [MediaKinds.STICKER]: 'Sticker',
  [MediaKinds.ANIMATION]: 'GIF',
  [MediaKinds.DOCUMENT]: 'File',
  [MediaKinds.LOCATION]: 'Location',
  [MediaKinds.CONTACT]: 'Contact',
  [MediaKinds.POLL]: 'Poll',
  [MediaKinds.UNSUPPORTED]: 'Unsupported',
};

const BYTES_PER_UNIT = 1024;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** `2.4 MB`, `812 kB`, `44 B` -- one decimal only where it says something, which it does not for whole units. */
export const formatSize = (opts: { bytes: number }): string => {
  const { bytes } = opts;
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < units.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  // Bytes are whole things; a "1.0 B" would be inventing precision.
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0);
  return `${rounded} ${units[unit]}`;
};

/** `0:07`, `1:05`, `1:02:03` -- the hour only when there is one, as every player shows it. */
export const formatDuration = (opts: { seconds: number }): string => {
  const { seconds } = opts;
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  const minutes = Math.floor(whole / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const rest = whole % SECONDS_PER_MINUTE;
  const padded = String(rest).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${padded}`
    : `${minutes}:${padded}`;
};

/**
 * One line naming the media, with the detail that identifies this one.
 *
 * The detail differs by kind because what makes a file recognisable is its
 * name, what makes a voice message recognisable is its length, and what makes
 * a sticker recognisable is the emoji it stands for. A single generic shape --
 * kind plus size, say -- would be uniform and tell you nothing.
 */
export const describeMedia = (opts: { media: IMessageMedia }): string => {
  const { media } = opts;
  const glyph = MEDIA_GLYPHS[media.kind] ?? MEDIA_GLYPHS[MediaKinds.UNSUPPORTED];
  const label = MEDIA_LABELS[media.kind] ?? MEDIA_LABELS[MediaKinds.UNSUPPORTED];

  const details: string[] = [];
  switch (media.kind) {
    case MediaKinds.STICKER: {
      // The sticker's own emoji is the closest thing to seeing it, so it comes
      // first and the word "Sticker" is what qualifies it.
      return media.emoji ? `${media.emoji} ${label}` : `${glyph} ${label}`;
    }
    case MediaKinds.PHOTO: {
      if (media.width && media.height) {
        details.push(`${media.width}×${media.height}`);
      }
      break;
    }
    case MediaKinds.VOICE:
    case MediaKinds.VIDEO:
    case MediaKinds.ANIMATION: {
      if (media.duration !== undefined) {
        details.push(formatDuration({ seconds: media.duration }));
      }
      break;
    }
    case MediaKinds.AUDIO: {
      // A song's title is what it is; its duration is a detail about it.
      if (media.title) {
        details.push(media.title);
      }
      if (media.duration !== undefined) {
        details.push(formatDuration({ seconds: media.duration }));
      }
      break;
    }
    case MediaKinds.DOCUMENT: {
      if (media.title) {
        details.push(media.title);
      }
      if (media.size !== undefined) {
        details.push(formatSize({ bytes: media.size }));
      }
      break;
    }
    default: {
      if (media.title) {
        details.push(media.title);
      }
      break;
    }
  }

  const shown = details.filter(detail => detail !== '');
  // A file names itself, so "📎 File · report.pdf" says "File" twice: anything
  // carrying its own name stands in for the generic word.
  //
  // Gated on the title actually being there, not on there being any detail at
  // all -- a file with a size and no name is still a file, and "📎 900 B" reads
  // as a measurement rather than as something someone sent you.
  const namesItself = (media.kind === MediaKinds.DOCUMENT || media.kind === MediaKinds.AUDIO)
    && media.title !== undefined && media.title !== '';
  const head = namesItself ? `${glyph} ${shown[0]}` : `${glyph} ${label}`;
  const rest = namesItself ? shown.slice(1) : shown;

  return rest.length > 0 ? `${head} · ${rest.join(' · ')}` : head;
};
