import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { IApplicationConfiguration } from './common/index.ts';
import type { DatabaseService } from './cache/index.ts';
import type { IMessageAdapter } from './message-service.ts';

/**
 * The magic bytes of the formats chafa can decode.
 *
 * Checked because Telegram does not always send what was asked for: an
 * animated sticker's largest "thumbnail" is a WebM video, and asking for the
 * largest one got exactly that -- cached under an image's name, handed to a
 * decoder that refused it, and drawn as nothing. Rejecting it here keeps a
 * file that can never be drawn out of the cache, and says so in the log
 * rather than failing silently one layer down.
 */
const IMAGE_SIGNATURES: readonly { name: string; extension: string; bytes: readonly number[]; offset: number }[] = [
  { name: 'JPEG', extension: 'jpg', bytes: [0xff, 0xd8, 0xff], offset: 0 },
  { name: 'PNG', extension: 'png', bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 },
  // RIFF....WEBP -- the four size bytes between are not part of the signature.
  { name: 'WebP', extension: 'webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { name: 'GIF', extension: 'gif', bytes: [0x47, 0x49, 0x46], offset: 0 },
];

const isDrawableImage = (opts: { bytes: Uint8Array }): boolean =>
  IMAGE_SIGNATURES.some(({ bytes, offset }) =>
    bytes.every((byte, index) => opts.bytes[offset + index] === byte));

/** Written 0600 like everything else tglow stores: a cached photo is message content. */
const THUMBNAIL_FILE_MODE = 0o600;
const THUMBNAIL_DIRECTORY_MODE = 0o700;

/**
 * The pictures on messages, fetched once and kept.
 *
 * A thumbnail never changes -- Telegram would issue a new message rather than
 * edit the bytes under one -- so the first fetch is the only one, and every
 * later launch reads it off disk. That matters more here than it looks:
 * downloading requires re-fetching the message first, because file references
 * expire, so an uncached picture costs two round trips.
 *
 * Nothing here throws. A picture that cannot be fetched is a message that
 * renders as its descriptor, which is what every message did until recently
 * and is a perfectly good outcome; a throw would take the conversation with
 * it.
 */
export class ThumbnailService {
  private readonly _logger: ILogger = ApplicationLogger.get(ThumbnailService.name);
  /**
   * Peers and messages already found to have nothing to draw, so a chat full
   * of text does not re-ask Telegram about every one of them on every render.
   * In memory only: it is a fact about this session's attempts, not about the
   * messages, and a restart is exactly when it is worth trying again.
   */
  private readonly _missing = new Set<string>();
  /** In-flight fetches, so a message drawn twice in one frame is fetched once. */
  private readonly _inFlight = new Map<string, Promise<Uint8Array | null>>();

  constructor(
    @inject({ key: BindingKeys.MESSAGE_ADAPTER }) private readonly _adapter: IMessageAdapter,
    @inject({ key: BindingKeys.CONFIGURATION }) private readonly _configuration: IApplicationConfiguration,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
  ) {}

  /**
   * `<peer>-<id>.bin`, not `.jpg`: Telegram sends JPEG for photos and WebP for
   * stickers, chafa decodes both from their own headers, and a name claiming
   * one would be wrong for the other.
   */
  private pathFor = (opts: { peerId: string; messageId: number }): string =>
    join(this._configuration.thumbnailDirectory, `${opts.peerId}-${opts.messageId}.bin`);

  private keyFor = (opts: { peerId: string; messageId: number }): string =>
    `${opts.peerId}:${opts.messageId}`;

  /** What is already on disk, or null. Never the network. */
  cached = (opts: { peerId: string; messageId: number }): Uint8Array | null => {
    const path = this.pathFor(opts);
    try {
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    } catch (error) {
      this._logger.for('cached').error('Could not read %s | Reason: %s', path, error);
      return null;
    }
  };

  /**
   * The picture for a message, from disk if it is there and from Telegram if
   * it is not.
   *
   * Returns null for anything with no picture, and remembers that so the same
   * message is not asked about again this session.
   */
  fetch = async (opts: { peerId: string; messageId: number }): Promise<Uint8Array | null> => {
    const key = this.keyFor(opts);
    if (this._missing.has(key)) {
      return null;
    }

    const onDisk = this.cached(opts);
    if (onDisk !== null) {
      return onDisk;
    }

    // One fetch per message, however many times a frame asks: without this a
    // photo scrolling into view starts a download on every render until the
    // first one lands.
    const existing = this._inFlight.get(key);
    if (existing) {
      return existing;
    }

    const download = this.download({ ...opts, key });
    this._inFlight.set(key, download);
    try {
      return await download;
    } finally {
      this._inFlight.delete(key);
    }
  };

  /**
   * The picture at full size, written somewhere a viewer can open it.
   *
   * Because a terminal that cannot display images cannot be made to. Alacritty
   * has no Sixel and no Kitty graphics protocol -- verified against the binary
   * rather than assumed -- so the drawn version is the best that fits *in* the
   * window, and this is the way to the real thing: hand the file to whatever
   * the desktop uses to open pictures.
   *
   * Returns the path, or null when there was nothing to write.
   */
  materialise = async (opts: { peerId: string; messageId: number }): Promise<string | null> => {
    const { peerId, messageId } = opts;
    const peerType = this._database.listPeerKinds().get(peerId)?.type ?? 'user';

    let bytes: Uint8Array | null;
    try {
      bytes = await this._adapter.downloadMedia({ peerId, messageId, peerType });
    } catch (error) {
      this._logger.for('materialise').error('Could not download %s:%s | Reason: %s', peerId, messageId, error);
      return null;
    }
    if (bytes === null || bytes.length === 0) {
      return null;
    }

    // Named by what it is, so the viewer picks the right application: a file
    // called .bin opens in a text editor, or in nothing at all.
    const extension = IMAGE_SIGNATURES.find(({ bytes: signature, offset }) =>
      signature.every((byte, index) => bytes[offset + index] === byte))?.extension ?? 'bin';
    const path = join(this._configuration.thumbnailDirectory, `${peerId}-${messageId}-full.${extension}`);
    try {
      mkdirSync(this._configuration.thumbnailDirectory, { recursive: true, mode: THUMBNAIL_DIRECTORY_MODE });
      writeFileSync(path, bytes, { mode: THUMBNAIL_FILE_MODE });
    } catch (error) {
      this._logger.for('materialise').error('Could not write %s | Reason: %s', path, error);
      return null;
    }
    return path;
  };

  private download = async (opts: { peerId: string; messageId: number; key: string }): Promise<Uint8Array | null> => {
    const { peerId, messageId, key } = opts;
    let bytes: Uint8Array | null;
    try {
      // The peer's type, because a bare id is not enough to ask GramJS about a
      // channel -- see toMarkedPeer in telegram-adapter.ts. Defaulted to
      // 'user' for a peer that is somehow not cached, which is the shape a
      // bare id already implies.
      const peerType = this._database.listPeerKinds().get(peerId)?.type ?? 'user';
      bytes = await this._adapter.downloadThumbnail({ peerId, messageId, peerType });
    } catch (error) {
      // Not remembered as missing: this is a network failure, not an absence,
      // and the picture is probably still there next time.
      this._logger.for('download').error('Could not download the thumbnail for %s | Reason: %s', key, error);
      return null;
    }

    if (bytes === null || bytes.length === 0) {
      this._missing.add(key);
      return null;
    }

    if (!isDrawableImage({ bytes })) {
      // Remembered as missing: the answer will be the same next time, and
      // asking again costs two round trips per render.
      this._logger.for('download').info('Nothing drawable for %s -- not an image tglow can decode', key);
      this._missing.add(key);
      return null;
    }

    try {
      mkdirSync(this._configuration.thumbnailDirectory, { recursive: true, mode: THUMBNAIL_DIRECTORY_MODE });
      writeFileSync(this.pathFor({ peerId, messageId }), bytes, { mode: THUMBNAIL_FILE_MODE });
    } catch (error) {
      // The picture is in hand; only keeping it failed. Drawing it now and
      // re-fetching next launch is strictly better than throwing it away.
      this._logger.for('download').error('Could not cache the thumbnail for %s | Reason: %s', key, error);
    }
    return bytes;
  };
}
