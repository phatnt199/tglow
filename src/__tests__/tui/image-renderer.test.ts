import { test, expect } from 'bun:test';
import { deflateSync } from 'node:zlib';

import { renderImage } from '../../tui/image-renderer.ts';

/**
 * A real PNG, built here rather than pasted as base64: a hand-typed blob is a
 * blob nobody can check, and the first attempt at one was silently corrupt.
 */
const buildPng = (opts: { width: number; height: number }): Uint8Array => {
  const { width, height } = opts;
  const raw: number[] = [];
  for (let y = 0; y < height; y += 1) {
    raw.push(0);
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const inside = dx * dx + dy * dy < (width / 3) * (width / 3);
      raw.push(inside ? 235 : 20, inside ? 193 : 20, inside ? 122 : 24);
    }
  }

  const table = Array.from({ length: 256 }, (unused, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  const crc = (buffer: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buffer) {
      c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]));
};

test('a picture comes back as a grid of cells inside the size asked for', async () => {
  const cells = await renderImage({ bytes: buildPng({ width: 64, height: 64 }), maximumColumns: 16, maximumRows: 8 });

  expect(cells).not.toBeNull();
  expect(cells!.length).toBeLessThanOrEqual(8);
  expect(cells![0]!.length).toBeLessThanOrEqual(16);
  expect(cells!.every(row => row.length === cells![0]!.length)).toBe(true);
});

// The point of using chafa rather than one glyph: it picks the character that
// best fits each cell, so a picture with an edge in it uses more than blanks.
test('an image with shape in it uses more than one glyph', async () => {
  const cells = await renderImage({ bytes: buildPng({ width: 64, height: 64 }), maximumColumns: 20, maximumRows: 10 });
  const glyphs = new Set(cells!.flat().map(cell => cell.char));

  expect(glyphs.size).toBeGreaterThan(1);
});

// Every colour must be drawable: a malformed hex would reach the renderer and
// be rejected there, one frame later and much harder to trace.
test('every colour is a six-digit hex or nothing at all', async () => {
  const cells = await renderImage({ bytes: buildPng({ width: 32, height: 32 }), maximumColumns: 10, maximumRows: 5 });

  for (const cell of cells!.flat()) {
    for (const colour of [cell.foreground, cell.background]) {
      if (colour !== null) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  }
});

// A photo that will not decode is one message rendering as its descriptor. A
// throw here would be the whole conversation failing to draw.
test('anything undrawable comes back as null rather than throwing', async () => {
  expect(await renderImage({ bytes: new Uint8Array([1, 2, 3, 4]), maximumColumns: 10, maximumRows: 4 })).toBeNull();
  expect(await renderImage({ bytes: new Uint8Array(), maximumColumns: 10, maximumRows: 4 })).toBeNull();
  expect(await renderImage({ bytes: buildPng({ width: 8, height: 8 }), maximumColumns: 0, maximumRows: 4 })).toBeNull();
});

// Two photos arriving together must wait on one start rather than each
// compiling two megabytes of WebAssembly.
test('several pictures at once share one started module', async () => {
  const bytes = buildPng({ width: 32, height: 32 });
  const all = await Promise.all([1, 2, 3].map(async () =>
    renderImage({ bytes, maximumColumns: 8, maximumRows: 4 })));

  expect(all.every(cells => cells !== null)).toBe(true);
});
