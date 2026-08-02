import { test, expect } from 'bun:test';

import { renderWithKeys } from '../helpers/render.tsx';
import { extractTailToWidth, measureTextWidth, padToWidth, truncateToWidth } from '../../src/tui/text-width.ts';

// The whole point of measureTextWidth is to agree with the renderer: a wrap
// width computed from anything else re-opens the overdraw that made messages
// unreadable. So the primary test is not a table of expected numbers, it is a
// comparison against how many cells OpenTUI actually consumed.
//
// captureCharFrame returns one JS character per *character*, not per cell, so
// a wide glyph shortens the row string rather than lengthening it. For a row
// of `columns` cells holding `sample` followed by padding spaces:
//
//   rowLength = sample.length + (columns - cells(sample))
//
// which rearranges to the identity used below. Verified against a plain ASCII
// sample, where cells and lengths coincide.
const PROBE_COLUMNS = 40;

const measureRenderedCells = async (sample: string): Promise<number> => {
  const renderer = await renderWithKeys(
    <box flexDirection="column" width={PROBE_COLUMNS}>
      <text>{sample}</text>
    </box>,
    { width: PROBE_COLUMNS, height: 2 },
  );
  await renderer.flush();
  const row = renderer.captureCharFrame().split('\n')[0]!;
  return PROBE_COLUMNS + sample.length - row.length;
};

const SAMPLES: readonly string[] = [
  'plain ascii',
  '',
  'Đức anh hoàng',
  'Em Việt Tú',
  'Đức anh hoàng'.normalize('NFD'),
  'Em Việt Tú'.normalize('NFD'),
  '你好世界',
  'こんにちは',
  '안녕하세요',
  'ＦＵＬＬＷＩＤＴＨ',
  '🔥',
  '🔥🔥🔥',
  '👨‍👩‍👧',
  '🇻🇳',
  '🚀 ship it',
  '你好 world 🔥',
  '▎',
  '…',
  '│─',
  '❯ █',
];

test('measured width matches the cells OpenTUI actually consumes', async () => {
  for (const sample of SAMPLES) {
    const rendered = await measureRenderedCells(sample);
    expect({ sample, width: measureTextWidth({ text: sample }) }).toEqual({ sample, width: rendered });
  }
});

// The three failure modes a naive implementation has, stated directly so a
// regression names itself rather than showing up as an off-by-two somewhere
// downstream.
test('a wide ideograph counts two columns, not one code point', () => {
  expect(measureTextWidth({ text: '你好' })).toBe(4);
  expect(Array.from('你好').length).toBe(2);
});

test('a combining mark counts nothing of its own', () => {
  const decomposed = 'Đức'.normalize('NFD');
  expect(decomposed.length).toBeGreaterThan(3);
  expect(measureTextWidth({ text: decomposed })).toBe(3);
});

test('a ZWJ emoji sequence counts as one two-column glyph', () => {
  expect(measureTextWidth({ text: '👨‍👩‍👧' })).toBe(2);
});

test('truncateToWidth never exceeds the width it is given', () => {
  for (const text of SAMPLES) {
    for (const width of [0, 1, 2, 3, 7, 40]) {
      const truncated = truncateToWidth({ text, width });
      expect({ text, width, over: measureTextWidth({ text: truncated }) > width }).toEqual({
        text, width, over: false,
      });
    }
  }
});

test('truncateToWidth marks a shortened string with an ellipsis', () => {
  expect(truncateToWidth({ text: 'Đức anh hoàng', width: 8 })).toBe('Đức anh…');
  expect(truncateToWidth({ text: 'Đức anh hoàng', width: 40 })).toBe('Đức anh hoàng');
});

// A wide glyph cannot be split down the middle: dropping to the previous
// grapheme leaves one column spare, and the pad has to make it up or the row
// comes out a column short and the column structure drifts.
test('truncateToWidth pads back to the full width when a wide glyph will not fit', () => {
  const truncated = truncateToWidth({ text: '你好世界', width: 5 });
  expect(measureTextWidth({ text: truncated })).toBe(5);
});

test('padToWidth pads in columns, not in code units', () => {
  expect(measureTextWidth({ text: padToWidth({ text: '你好', width: 10 }) })).toBe(10);
  expect(measureTextWidth({ text: padToWidth({ text: 'Việt'.normalize('NFD'), width: 10 }) })).toBe(10);
});

test('padToWidth leaves a string already at or past the width alone', () => {
  expect(padToWidth({ text: 'exactly', width: 7 })).toBe('exactly');
  expect(padToWidth({ text: 'over the limit', width: 4 })).toBe('over the limit');
});

test('extractTailToWidth keeps the end of the string, where the caret is', () => {
  expect(extractTailToWidth({ text: 'on my way now', width: 7 })).toBe('way now');
  expect(extractTailToWidth({ text: 'short', width: 40 })).toBe('short');
  expect(extractTailToWidth({ text: 'anything', width: 0 })).toBe('');
});

test('extractTailToWidth never exceeds the width, and never halves a glyph', () => {
  for (const text of SAMPLES) {
    for (const width of [0, 1, 2, 3, 7, 40]) {
      const tail = extractTailToWidth({ text, width });
      expect({ text, width, over: measureTextWidth({ text: tail }) > width }).toEqual({ text, width, over: false });
      expect({ text, width, suffix: text.endsWith(tail) }).toEqual({ text, width, suffix: true });
    }
  }
  // Five columns hold two wide glyphs and cannot hold a third, so the tail
  // comes back a column short rather than splitting one down the middle.
  expect(extractTailToWidth({ text: '你好世界', width: 5 })).toBe('世界');
});
