import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseService } from '../../core/cache/index.ts';
import type { IApplicationConfiguration } from '../../core/common/index.ts';
import type { IMessageAdapter } from '../../core/message-service.ts';
import { ThumbnailService } from '../../core/thumbnail-service.ts';

/** A valid JPEG header is all isDrawableImage looks at, and all these tests need. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
/** What an animated sticker's "thumbnail" actually is: a WebM, which chafa cannot draw. */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]);

const build = (opts: {
  download?: (request: { peerId: string; messageId: number; peerType: string }) => Promise<Uint8Array | null>;
  peerType?: 'user' | 'channel';
}): { service: ThumbnailService; directory: string; asked: Array<{ peerId: string; peerType: string }>; database: DatabaseService } => {
  const directory = mkdtempSync(join(tmpdir(), 'tglow-thumbs-'));
  const asked: Array<{ peerId: string; peerType: string }> = [];
  const adapter = {
    downloadThumbnail: async (request: { peerId: string; messageId: number; peerType: string }) => {
      asked.push({ peerId: request.peerId, peerType: request.peerType });
      return opts.download ? opts.download(request) : JPEG;
    },
  } as unknown as IMessageAdapter;

  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'p1', type: opts.peerType ?? 'user', accessHash: 'h', title: 'Alice', username: null });

  const configuration = { thumbnailDirectory: directory } as unknown as IApplicationConfiguration;
  return { service: new ThumbnailService(adapter, configuration, database), directory, asked, database };
};

test('a downloaded picture is kept on disk and read back from there', async () => {
  const harness = build({});

  const first = await harness.service.fetch({ peerId: 'p1', messageId: 7 });
  expect(first).toEqual(JPEG);
  expect(harness.asked).toHaveLength(1);

  // Second time: off disk, no download.
  const second = await harness.service.fetch({ peerId: 'p1', messageId: 7 });
  expect(second).toEqual(JPEG);
  expect(harness.asked).toHaveLength(1);
  harness.database.close();
});

// An animated sticker's largest "thumbnail" is a WebM video. Caching it under
// an image's name meant a file that could never be drawn, handed to a decoder
// that refused it, and a picture that never appeared.
test('anything that is not a drawable image is refused, not cached', async () => {
  const harness = build({ download: async () => WEBM });

  expect(await harness.service.fetch({ peerId: 'p1', messageId: 7 })).toBeNull();
  // And never asked again: the answer will be the same, and asking costs two
  // round trips.
  expect(await harness.service.fetch({ peerId: 'p1', messageId: 7 })).toBeNull();
  expect(harness.asked).toHaveLength(1);
  harness.database.close();
});

// tglow stores unmarked peer ids and GramJS resolves a bare number as a user,
// so a channel's picture needs the type or the download fails with an error
// that reads like a network fault.
test('the peer type is handed over so a channel can be resolved', async () => {
  const harness = build({ peerType: 'channel' });

  await harness.service.fetch({ peerId: 'p1', messageId: 7 });

  expect(harness.asked[0]).toEqual({ peerId: 'p1', peerType: 'channel' });
  harness.database.close();
});

// A network failure is not an absence: the picture is probably still there
// next time, so it must stay willing to ask again.
test('a failed download is retried, an absent picture is not', async () => {
  const failing = build({ download: async () => { throw new Error('NETWORK_DOWN'); } });
  expect(await failing.service.fetch({ peerId: 'p1', messageId: 7 })).toBeNull();
  expect(await failing.service.fetch({ peerId: 'p1', messageId: 7 })).toBeNull();
  expect(failing.asked).toHaveLength(2);
  failing.database.close();

  const absent = build({ download: async () => null });
  expect(await absent.service.fetch({ peerId: 'p1', messageId: 7 })).toBeNull();
  expect(await absent.service.fetch({ peerId: 'p1', messageId: 7 })).toBeNull();
  expect(absent.asked).toHaveLength(1);
  absent.database.close();
});

// A photo scrolling into view asks on every render until the first fetch
// lands, so without this one picture starts a dozen downloads.
test('a picture asked for twice at once is downloaded once', async () => {
  // A box, not a `let`: TypeScript narrows a local assigned only inside a
  // callback and then refuses to call it.
  const gate: { release: (() => void) | null } = { release: null };
  const harness = build({
    download: async () => {
      await new Promise<void>(resolve => { gate.release = resolve; });
      return JPEG;
    },
  });

  const both = Promise.all([
    harness.service.fetch({ peerId: 'p1', messageId: 7 }),
    harness.service.fetch({ peerId: 'p1', messageId: 7 }),
  ]);
  await new Promise(resolve => { setTimeout(resolve, 10); });
  gate.release?.();

  expect(await both).toEqual([JPEG, JPEG]);
  expect(harness.asked).toHaveLength(1);
  harness.database.close();
});

// A cache write that fails costs a re-fetch next launch, which is strictly
// better than throwing the picture away after paying to download it.
test('a picture is still returned when it cannot be cached', async () => {
  const harness = build({});
  // A path that cannot be created: a file where the directory should be.
  const blocked = join(mkdtempSync(join(tmpdir(), 'tglow-blocked-')), 'thumbs');
  writeFileSync(blocked, 'not a directory');
  const configuration = { thumbnailDirectory: blocked } as unknown as IApplicationConfiguration;
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'p1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  const service = new ThumbnailService(
    { downloadThumbnail: async () => JPEG } as unknown as IMessageAdapter,
    configuration,
    database,
  );

  expect(await service.fetch({ peerId: 'p1', messageId: 7 })).toEqual(JPEG);
  harness.database.close();
  database.close();
});

test('what is already on disk is readable without any network at all', async () => {
  const harness = build({ download: async () => { throw new Error('should not be called'); } });
  mkdirSync(harness.directory, { recursive: true });
  writeFileSync(join(harness.directory, 'p1-7.bin'), JPEG);

  expect(harness.service.cached({ peerId: 'p1', messageId: 7 })).toEqual(JPEG);
  expect(harness.service.cached({ peerId: 'p1', messageId: 8 })).toBeNull();
  expect(harness.asked).toHaveLength(0);
  harness.database.close();
});
