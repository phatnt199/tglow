import { test, expect } from 'bun:test';

import { rgbToHex } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import { VimModes, type TVimMode } from '../../../src/keys/common/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../src/tui/theme/index.ts';
import { StatusLine, type IStatusLineProps } from '../../../src/tui/panes/status-line.tsx';

const tokens = buildTokens({ paletteName: 'sage' });
const STATUS_WIDTH = 60;

const toHex = (colour: Parameters<typeof rgbToHex>[0]): string => rgbToHex(colour).toLowerCase();

const render = async (overrides: Partial<IStatusLineProps> = {}): Promise<TestRendererSetup> => {
  const props: IStatusLineProps = {
    mode: VimModes.NORMAL,
    title: 'Alice',
    unreadCount: 0,
    position: 1,
    total: 1,
    hint: '',
    tokens,
    width: STATUS_WIDTH,
    ...overrides,
  };
  const renderer = await renderWithKeys(<StatusLine {...props} />, { width: props.width, height: 1 });
  await renderer.flush();
  return renderer;
};

const readRow = (renderer: TestRendererSetup): string => renderer.captureCharFrame().split('\n')[0]!;

test('shows mode, chat, unread count and position', async () => {
  const frame = readRow(await render({ unreadCount: 3, position: 4, total: 312, hint: '\\ for keys' }));
  expect(frame).toContain('NORMAL');
  expect(frame).toContain('Alice');
  expect(frame).toContain('3 unread');
  expect(frame).toContain('4/312');
  // A JSX attribute is not a string literal: "\\ for keys" puts two
  // backslashes on the screen, which is what App shipped.
  expect(frame).toContain('\\ for keys');
  expect(frame).not.toContain('\\\\');
});

test('the mode label is upper case, like lualine', async () => {
  expect(readRow(await render({ mode: VimModes.INSERT }))).toContain('INSERT');
});

test('a zero unread count is not shown', async () => {
  expect(readRow(await render({ unreadCount: 0 }))).not.toContain('unread');
});

// lualine's section A is a block of colour, not coloured text on the terminal
// background. The old status line coloured the label and left the block
// missing entirely.
test('the mode sits in a block of its own colour, with the background colour as its text', async () => {
  const renderer = await render({ mode: VimModes.NORMAL });
  const block = renderer.captureSpans().lines[0]!.spans[0]!;
  expect(block.text).toContain('NORMAL');
  expect(toHex(block.bg)).toBe(tokens.modeNormal.toLowerCase());
  expect(toHex(block.fg)).toBe(tokens.background.toLowerCase());
});

test('each mode brings its own block colour', async () => {
  const cases: [TVimMode, string][] = [
    [VimModes.NORMAL, tokens.modeNormal],
    [VimModes.INSERT, tokens.modeInsert],
    [VimModes.VISUAL, tokens.modeVisual],
  ];
  for (const [mode, colour] of cases) {
    const renderer = await render({ mode });
    expect({ mode, bg: toHex(renderer.captureSpans().lines[0]!.spans[0]!.bg) }).toEqual({
      mode,
      bg: colour.toLowerCase(),
    });
  }
});

// The owner's lualine sets section_separators to empty strings: the powerline
// look was deliberately rejected. The pipe the old status line used is the
// same idea in a cheaper glyph.
test('separators are spaces and a middle dot, never pipes or chevrons', async () => {
  const frame = readRow(await render({ unreadCount: 2, position: 4, total: 6, hint: '\\ for keys' }));
  expect(frame).not.toContain('│');
  // The private-use powerline chevrons, by code point: writing them literally
  // is how a separator assertion quietly becomes `not.toContain('')`, which
  // every string on earth satisfies.
  expect(frame).not.toContain('');
  expect(frame).not.toContain('');
  expect(frame).toContain('Alice · 2 unread');
});

test('position and hint are pushed to the right edge', async () => {
  const row = readRow(await render({ position: 4, total: 6, hint: '\\ for keys' }));
  expect(row.length).toBe(STATUS_WIDTH);
  expect(row.trimEnd().endsWith('\\ for keys')).toBe(true);
  // One column of padding at the right edge, matching the one at the left.
  expect(row.length - row.trimEnd().length).toBe(1);
  expect(row).toContain('4/6');
});

// A long group title used to run straight into the position, or off the pane.
test('a title too long for the line is ellipsised rather than pushing the position off the edge', async () => {
  const row = readRow(await render({
    title: 'a very long group chat title that will not fit beside anything else at all',
    unreadCount: 41,
    position: 7,
    total: 900,
    hint: '\\ for keys',
  }));
  expect(row.length).toBe(STATUS_WIDTH);
  expect(row).toContain('…');
  expect(row.trimEnd().endsWith('\\ for keys')).toBe(true);
  expect(row).toContain('7/900');
});

test('a title of wide characters still leaves the right edge intact', async () => {
  const row = readRow(await render({
    title: '张伟同学的群聊天室 · 每日闲聊',
    position: 12,
    total: 34,
    hint: '\\ for keys',
  }));
  expect(row.trimEnd().endsWith('\\ for keys')).toBe(true);
  expect(renderRowColumns(row)).toBe(STATUS_WIDTH);
});

// captureCharFrame gives one character per character, not per cell, so a wide
// glyph shortens the row string. Recovering the column count needs the width
// of what is actually in it.
const renderRowColumns = (row: string): number => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let columns = 0;
  for (const segment of segmenter.segment(row)) {
    const codePoint = segment.segment.codePointAt(0) ?? 0;
    columns += codePoint >= 0x2e80 && codePoint <= 0x9fff ? 2 : 1;
  }
  return columns;
};

test('renders without a hint', async () => {
  const row = readRow(await render({ hint: '', position: 2, total: 9 }));
  expect(row).toContain('2/9');
  expect(row.trimEnd().endsWith('2/9')).toBe(true);
});
