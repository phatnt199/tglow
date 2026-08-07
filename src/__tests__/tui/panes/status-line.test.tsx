import { test, expect } from 'bun:test';

import { rgbToHex } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import { INITIAL_ENGINE_STATE, Operators, VimModes, type IEngineState, type TVimMode } from '../../../keys/common/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../tui/theme/index.ts';
import { StatusLine, type IStatusLineProps } from '../../../tui/panes/status-line.tsx';

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
    confirming: false,
    warning: false,
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
// It is still ellipsised -- but only past half the line, which is as much as a
// title may claim before the readouts start competing with it.
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
  // The position holds the right edge, and the hint is what gave way for it.
  expect(row.trimEnd().endsWith('7/900')).toBe(true);
  expect(row).not.toContain('for keys');
});

test('a title of wide characters still leaves the right edge intact', async () => {
  const row = readRow(await render({
    title: '张伟同学的群聊天室 · 每日闲聊',
    position: 12,
    total: 34,
    hint: '\\ for keys',
  }));
  expect(row.trimEnd().endsWith('12/34')).toBe(true);
  expect(renderRowColumns(row)).toBe(STATUS_WIDTH);
});

// The hint teaches the keymap once and is noise forever after, so it is the
// first thing the line gives up -- but only when something has to go. On a
// line with room for everything it stays, or it would never teach anyone.
test('the hint survives when there is room and goes first when there is not', async () => {
  const roomy = readRow(await render({ title: 'Alice', position: 4, total: 6, hint: '\\ for keys' }));
  expect(roomy.trimEnd().endsWith('\\ for keys')).toBe(true);

  const crowded = readRow(await render({
    title: 'Alice', position: 4, total: 6, hint: '\\ for keys', width: 34,
  }));
  expect(crowded).not.toContain('for keys');
  expect(crowded).toContain('4/6');
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

// Task 8: the only irreversible action in the app gets a colour, not another
// row -- the status line stays exactly one row (see app.tsx's own
// STATUS_LINE_HEIGHT comment) whether or not a delete is pending confirmation.
test('the title turns the danger colour while a destructive action is pending confirmation', async () => {
  const renderer = await render({ confirming: true, title: 'Delete this message? (y/n)' });
  const span = renderer.captureSpans().lines[0]!.spans.find(candidate => candidate.text.includes('Delete this message'));
  expect(span).toBeDefined();
  expect(toHex(span!.fg)).toBe(tokens.error.toLowerCase());
});

test('the title keeps the ordinary colour when nothing is pending confirmation', async () => {
  const renderer = await render({ confirming: false, title: 'Alice' });
  const span = renderer.captureSpans().lines[0]!.spans.find(candidate => candidate.text.includes('Alice'));
  expect(span).toBeDefined();
  expect(toHex(span!.fg)).toBe(tokens.foreground.toLowerCase());
});

// Waiting on y/n is a mode: every other key is dropped. The owner's lualine
// gives its one blocking mode -- replace -- a block of its own colour rather
// than leaving it reading NORMAL, and this is tglow's equivalent.
test('the mode block turns the danger colour while confirmation is blocking every other key', async () => {
  const renderer = await render({ mode: VimModes.NORMAL, confirming: true, title: 'Delete this message? (y/n)' });
  const block = renderer.captureSpans().lines[0]!.spans[0]!;
  expect(block.text).toContain('NORMAL');
  expect(toHex(block.bg)).toBe(tokens.error.toLowerCase());
});

// A warning is not a mode: it reports something that already happened and
// every key still works, so the block must keep saying which mode you are in.
test('a warning colours the message but leaves the mode block alone', async () => {
  const renderer = await render({ mode: VimModes.NORMAL, warning: true, title: 'Some updates may be missing' });
  expect(toHex(renderer.captureSpans().lines[0]!.spans[0]!.bg)).toBe(tokens.modeNormal.toLowerCase());
});


// ── the enriched line ─────────────────────────────────────────────────────

// A wide terminal has room for all of it, and the request this answers was for
// more information rather than less.
test('a wide line carries everything it is given', async () => {
  const row = readRow(await render({
    width: 110,
    title: 'Alice',
    position: 12,
    total: 240,
    unreadCount: 3,
    hint: '\\ for keys',
    connection: 'connected',
    folder: 'Work',
    peerKind: 'group',
    typing: 'typing…',
    messageId: 1482,
    messageTime: '14:32',
    messagePinned: true,
  }));

  expect(row).toContain('●');
  expect(row).toContain('Work');
  expect(row).toContain('Alice · group · 3 unread · typing…');
  expect(row).toContain('⚑');
  expect(row).toContain('#1482');
  expect(row).toContain('14:32');
  expect(row).toContain('4%');
  expect(row).toContain('12/240');
  expect(row).toContain('\\ for keys');
});

// showcmd is the field that answers "why did nothing happen when I pressed
// that?", so it outranks every readout beside it.
test('a half-typed command is shown, and outlives the readouts around it', async () => {
  const engine: IEngineState = { ...INITIAL_ENGINE_STATE, register: 'a', count: 3, operator: Operators.DELETE };
  const row = readRow(await render({
    width: 40, title: 'Alice', position: 12, total: 240, hint: '\\ for keys', engine,
  }));

  expect(row).toContain('"a3d');
  expect(row).not.toContain('for keys');
});

// Only while typing: the count answers "how much room is left", which is not a
// question anyone has in normal mode.
test('the composer length is shown in insert mode and not otherwise', async () => {
  const props = { title: 'Alice', composerLength: 137, width: 80 };
  expect(readRow(await render({ ...props, mode: VimModes.INSERT }))).toContain('137/4096');
  expect(readRow(await render({ ...props, mode: VimModes.NORMAL }))).not.toContain('137');
});

// Telegram refuses the send past the limit, so the count has to say so before
// the user finds out by losing what they wrote.
//
// Rendered and read one at a time: a second renderer frees the first one's
// buffer, and captureSpans on the stale one throws rather than returning
// something wrong -- which is at least honest, but it is not a test result.
const colourOf = async (
  overrides: Partial<IStatusLineProps>, text: string,
): Promise<string | undefined> => {
  const renderer = await render(overrides);
  const span = renderer.captureSpans().lines[0]?.spans.find(item => item.text.includes(text));
  return span === undefined ? undefined : rgbToHex(span.fg).toLowerCase();
};

test('a composer past the limit turns the count red', async () => {
  expect(await colourOf({ mode: VimModes.INSERT, composerLength: 10, width: 80 }, '10/4096'))
    .toBe(tokens.dim.toLowerCase());
  expect(await colourOf({ mode: VimModes.INSERT, composerLength: 5000, width: 80 }, '5000/4096'))
    .toBe(tokens.error.toLowerCase());
});

// The good case must not draw the eye: an always-lit indicator trains people
// to stop seeing the field, and then it cannot report the bad case either.
test('a lost connection is marked and coloured, a healthy one only marked', async () => {
  expect(await colourOf({ connection: 'connected', width: 80 }, '●')).toBe(tokens.dim.toLowerCase());
  expect(await colourOf({ connection: 'offline', width: 80 }, '✕')).toBe(tokens.error.toLowerCase());
});

// The reported bug this was found by: a warning is not a chat name. It is a
// message about data the user may have lost, and every readout on the line is
// worth less than reading it in full.
test('a warning claims the width it needs, whatever else has to go', async () => {
  const warned = readRow(await render({
    width: 70,
    title: 'Some missed messages could not be saved',
    warning: true,
    unreadCount: 2,
    position: 1,
    total: 4,
    hint: '\\ for keys',
    connection: 'offline',
    messageId: 1,
    messageTime: '00:01',
  }));

  expect(warned).toContain('Some missed messages could not be saved');
  expect(warned).toContain('1/4');
});
