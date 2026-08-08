import { test, expect } from 'bun:test';

import { CHUNK_SIZE, clearPlacements, forget, place, supportsGraphics, transmit } from '../../tui/kitty-graphics.ts';

/** A solid RGBA image, which is what the protocol takes -- see transmit. */
const pixels = (opts: { width: number; height: number }): { width: number; height: number; data: Uint8Array } => ({
  width: opts.width,
  height: opts.height,
  data: new Uint8Array(opts.width * opts.height * 4).fill(200),
});

/** Built rather than typed, so the file stays free of raw control characters. */
const ESC = String.fromCharCode(27);
const APC = `${ESC}_G`;
const ST = `${ESC}\\`;

// APC ... ST. A terminal that does not understand the protocol skips the whole
// sequence rather than printing it, which is what makes the framing matter.
test('every sequence is framed as APC ... ST', () => {
  for (const sequence of [
    transmit({ id: 1, pixels: pixels({ width: 2, height: 2 }) }),
    forget({ id: 1 }),
    clearPlacements(),
  ]) {
    expect(sequence.startsWith(APC)).toBe(true);
    expect(sequence.endsWith(ST)).toBe(true);
  }
});

// Raw pixels, not the file. f=100 is the protocol's only compressed format
// and it means PNG specifically -- which is what this got wrong at first, and
// why kitty answered every Telegram thumbnail with EBADPNG.
test('a small image is transmitted as deflated RGBA, with its dimensions', () => {
  const sequence = transmit({ id: 7, pixels: pixels({ width: 3, height: 2 }) });

  expect(sequence).toContain('a=t');
  expect(sequence).toContain('f=32');
  expect(sequence).toContain('o=z');
  expect(sequence).toContain('s=3');
  expect(sequence).toContain('v=2');
  expect(sequence).toContain('i=7');
  expect(sequence).toContain('m=0');
  // Never the encoded file: a JPEG handed over as f=32 would be drawn as
  // noise, which is a worse failure than the refusal it replaced.
  expect(sequence).not.toContain('f=100');
});

// The protocol's own limit is 4096 bytes of payload per sequence. Exceeding it
// does not error -- it truncates, which appears as half a picture and no
// message about why.
test('a large image is split, and only the last chunk says it is last', () => {
  // Genuinely incompressible, from a fixed seed: this test is about what
  // happens when deflate *cannot* fit an image into one chunk, and both flat
  // colour and any periodic pattern squeeze down to a single one.
  let seed = 1;
  const noise = Uint8Array.from({ length: 200 * 200 * 4 }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % 256;
  });
  const sequence = transmit({ id: 3, pixels: { width: 200, height: 200, data: noise } });
  const chunks = sequence.split(APC).filter(part => part !== '');

  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    const payload = chunk.slice(chunk.indexOf(';') + 1, -ST.length);
    expect(payload.length).toBeLessThanOrEqual(CHUNK_SIZE);
  }
  expect(sequence.split('m=1').length - 1).toBe(chunks.length - 1);
  expect(sequence.split('m=0').length - 1).toBe(1);
});

// Only the first chunk carries the full control data; the rest carry just the
// continuation flag, which is what the protocol expects.
test('only the first chunk describes the image', () => {
  const sequence = transmit({ id: 3, pixels: pixels({ width: 64, height: 64 }) });
  const chunks = sequence.split(APC).filter(part => part !== '');

  expect(chunks[0]).toContain('f=32');
  expect(chunks.slice(1).every(chunk => !chunk.includes('f=32'))).toBe(true);
});

// Placing is separate from sending, so a picture that scrolls costs a few
// dozen bytes rather than the whole image again.
test('placing names the image rather than resending it', () => {
  const sequence = place({ placement: { id: 9, row: 4, column: 12, columns: 20, rows: 8 } });

  expect(sequence).toContain(`${ESC}[4;12H`);
  expect(sequence).toContain('a=p');
  expect(sequence).toContain('i=9');
  expect(sequence).toContain('c=20');
  expect(sequence).toContain('r=8');
  // No payload: the image is already in the terminal.
  expect(sequence.endsWith(`;${ST}`)).toBe(true);
});

// Without C=1 the terminal moves the cursor past the image, and the next thing
// tglow draws lands somewhere it did not choose.
test('placing leaves the cursor where it was', () => {
  expect(place({ placement: { id: 1, row: 1, column: 1, columns: 4, rows: 2 } })).toContain('C=1');
});

// The terminal's acknowledgement arrives on stdin, where tglow's key handler
// would read it as a burst of keystrokes nobody typed.
test('every sequence silences the terminal reply', () => {
  expect(transmit({ id: 1, pixels: pixels({ width: 1, height: 1 }) })).toContain('q=2');
  expect(place({ placement: { id: 1, row: 1, column: 1, columns: 1, rows: 1 } })).toContain('q=2');
  expect(forget({ id: 1 })).toContain('q=2');
});

// Transmitted images live in the terminal until deleted, so a long session
// would otherwise accumulate every photo it had scrolled past.
test('an image can be forgotten, and placements cleared without forgetting', () => {
  expect(forget({ id: 5 })).toContain('i=5');
  expect(forget({ id: 5 })).toContain('a=d');
  expect(clearPlacements()).toContain('a=d');
  expect(clearPlacements()).not.toContain('i=');
});

// ── detection ─────────────────────────────────────────────────────────────

test('the terminals that can show a picture are recognised', () => {
  expect(supportsGraphics({ environment: { TERM: 'xterm-kitty' } })).toBe(true);
  expect(supportsGraphics({ environment: { TERM: 'xterm-ghostty' } })).toBe(true);
  expect(supportsGraphics({ environment: { KITTY_WINDOW_ID: '1' } })).toBe(true);
  expect(supportsGraphics({ environment: { TERM_PROGRAM: 'WezTerm' } })).toBe(true);
});

// Alacritty has no graphics protocol at all, and asking it to take an image is
// asking for nothing to happen.
test('a terminal that cannot show a picture is not asked to', () => {
  expect(supportsGraphics({ environment: { TERM: 'xterm-256color' } })).toBe(false);
  expect(supportsGraphics({ environment: {} })).toBe(false);
});

// An escape hatch each way: one for a terminal this does not know about yet,
// and one for anybody who would rather have the drawing.
test('the environment can force the answer either way', () => {
  expect(supportsGraphics({ environment: { TGLOW_GRAPHICS: 'on', TERM: 'xterm-256color' } })).toBe(true);
  expect(supportsGraphics({ environment: { TGLOW_GRAPHICS: 'off', TERM: 'xterm-kitty' } })).toBe(false);
});
