import { test, expect } from 'bun:test';

import { describeMedia, formatDuration, formatSize, MediaKinds, type TMediaKind } from '../../core/media.ts';

test('sizes read the way a file manager writes them', () => {
  expect(formatSize({ bytes: 0 })).toBe('0 B');
  expect(formatSize({ bytes: 900 })).toBe('900 B');
  expect(formatSize({ bytes: 1024 })).toBe('1.0 kB');
  expect(formatSize({ bytes: 2516582 })).toBe('2.4 MB');
  // Past ten, the decimal is noise on a number nobody reads that precisely.
  expect(formatSize({ bytes: 52428800 })).toBe('50 MB');
});

test('a nonsense size says nothing rather than something wrong', () => {
  expect(formatSize({ bytes: -1 })).toBe('');
  expect(formatSize({ bytes: Number.NaN })).toBe('');
});

test('durations carry the hour only when there is one', () => {
  expect(formatDuration({ seconds: 7 })).toBe('0:07');
  expect(formatDuration({ seconds: 65 })).toBe('1:05');
  expect(formatDuration({ seconds: 600 })).toBe('10:00');
  expect(formatDuration({ seconds: 3723 })).toBe('1:02:03');
  expect(formatDuration({ seconds: -1 })).toBe('');
});

// The detail differs by kind because what makes a file recognisable is its
// name, what makes a voice message recognisable is its length, and what makes
// a sticker recognisable is the emoji it stands for.
test('each kind says the thing that identifies it', () => {
  expect(describeMedia({ media: { kind: MediaKinds.PHOTO, width: 1280, height: 960 } })).toBe('📷 Photo · 1280×960');
  expect(describeMedia({ media: { kind: MediaKinds.VOICE, duration: 12 } })).toBe('🎤 Voice · 0:12');
  expect(describeMedia({ media: { kind: MediaKinds.VIDEO, duration: 65 } })).toBe('🎬 Video · 1:05');
  expect(describeMedia({ media: { kind: MediaKinds.LOCATION } })).toBe('📍 Location');
});

// A sticker's own emoji is the closest thing to seeing it.
test('a sticker leads with its emoji, and falls back when it has none', () => {
  expect(describeMedia({ media: { kind: MediaKinds.STICKER, emoji: '🐱' } })).toBe('🐱 Sticker');
  expect(describeMedia({ media: { kind: MediaKinds.STICKER } })).toBe('🙂 Sticker');
});

// "📎 File · report.pdf" says "File" twice.
test('anything that names itself stands in for the generic word', () => {
  expect(describeMedia({ media: { kind: MediaKinds.DOCUMENT, title: 'report.pdf', size: 2516582 } }))
    .toBe('📎 report.pdf · 2.4 MB');
  expect(describeMedia({ media: { kind: MediaKinds.AUDIO, title: 'Diễm Xưa', duration: 245 } }))
    .toBe('🎵 Diễm Xưa · 4:05');
});

// A file with a size and no name is still a file: "📎 900 B" reads as a
// measurement rather than as something someone sent you.
test('a nameless file keeps the word File', () => {
  expect(describeMedia({ media: { kind: MediaKinds.DOCUMENT, size: 900 } })).toBe('📎 File · 900 B');
  expect(describeMedia({ media: { kind: MediaKinds.DOCUMENT } })).toBe('📎 File');
});

// Telegram adds media types; a client that renders nothing for a new one is
// back to the blank row this whole feature exists to remove.
test('a kind this version does not know still says something', () => {
  expect(describeMedia({ media: { kind: MediaKinds.UNSUPPORTED } })).toBe('❔ Unsupported');
});

// Every kind must be nameable: a missing glyph or label would render
// "undefined" into the conversation.
test('every kind has a glyph and a label', () => {
  const kinds = Object.values(MediaKinds).filter((kind): kind is TMediaKind => typeof kind === 'string');
  expect(kinds.length).toBeGreaterThan(0);
  for (const kind of kinds) {
    const described = describeMedia({ media: { kind } });
    expect(described.length).toBeGreaterThan(0);
    expect(described).not.toContain('undefined');
  }
});
