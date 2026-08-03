import { test, expect, spyOn } from 'bun:test';

import { buildOsc52Sequence, writeToClipboard } from '../../core/clipboard.ts';

const OSC52_PREFIX = '\x1b]52;c;';
const OSC52_TERMINATOR = '\x07';

/** The base64 payload sitting between OSC52_PREFIX and OSC52_TERMINATOR. */
const extractPayload = (sequence: string): string => {
  expect(sequence.startsWith(OSC52_PREFIX)).toBe(true);
  expect(sequence.endsWith(OSC52_TERMINATOR)).toBe(true);
  return sequence.slice(OSC52_PREFIX.length, sequence.length - OSC52_TERMINATOR.length);
};

test('wraps ASCII text in the exact OSC 52 clipboard-copy sequence', () => {
  const sequence = buildOsc52Sequence({ text: 'hello' });
  expect(sequence).toBe(`${OSC52_PREFIX}${Buffer.from('hello', 'utf-8').toString('base64')}${OSC52_TERMINATOR}`);
});

// The owner writes Vietnamese. Encoding from UTF-16 code units instead of
// UTF-8 bytes is exactly the mistake that copies mojibake instead of the
// text actually on screen -- this pins the correct behaviour by decoding the
// payload back out and checking it reproduces the original string exactly,
// not just that some base64 was produced.
test('encodes a Vietnamese string from its UTF-8 bytes, round-tripping exactly', () => {
  const text = 'Đức anh hoàng';
  const sequence = buildOsc52Sequence({ text });
  expect(sequence).toBe(`${OSC52_PREFIX}${Buffer.from(text, 'utf-8').toString('base64')}${OSC52_TERMINATOR}`);
  expect(Buffer.from(extractPayload(sequence), 'base64').toString('utf-8')).toBe(text);
});

// A non-BMP code point (every emoji): encoding by UTF-16 code unit splits it
// into a surrogate pair and corrupts it, the same class of bug as above.
test('encodes an emoji (non-BMP code point), round-tripping exactly', () => {
  const text = '🔥';
  const sequence = buildOsc52Sequence({ text });
  expect(Buffer.from(extractPayload(sequence), 'base64').toString('utf-8')).toBe(text);
});

test('a mix of Vietnamese, emoji and ASCII round-trips exactly', () => {
  const text = 'Đức anh hoàng 🔥 says hi';
  const sequence = buildOsc52Sequence({ text });
  expect(Buffer.from(extractPayload(sequence), 'base64').toString('utf-8')).toBe(text);
});

test('empty text produces a valid sequence with an empty payload, not a special case', () => {
  const sequence = buildOsc52Sequence({ text: '' });
  expect(sequence).toBe(`${OSC52_PREFIX}${OSC52_TERMINATOR}`);
  expect(extractPayload(sequence)).toBe('');
});

test('a long string round-trips exactly', () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(500);
  const sequence = buildOsc52Sequence({ text });
  expect(Buffer.from(extractPayload(sequence), 'base64').toString('utf-8')).toBe(text);
});

test('writeToClipboard calls the injected writer exactly once, with the built sequence', () => {
  const calls: string[] = [];
  writeToClipboard({ text: 'hello', write: (sequence: string): void => { calls.push(sequence); } });
  expect(calls).toEqual([buildOsc52Sequence({ text: 'hello' })]);
});

test('writeToClipboard never touches process.stdout itself', () => {
  const stdoutWriteSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

  try {
    writeToClipboard({ text: 'hello', write: (): void => {} });
  } finally {
    stdoutWriteSpy.mockRestore();
  }

  expect(stdoutWriteSpy).not.toHaveBeenCalled();
});
