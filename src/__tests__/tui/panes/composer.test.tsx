import { test, expect } from 'bun:test';

import { rgbToHex } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import { VimModes } from '../../../keys/common/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../tui/theme/index.ts';
import { Composer, type IComposerProps } from '../../../tui/panes/composer.tsx';
import { toGraphemes } from '../../../tui/composer-text.ts';

const tokens = buildTokens({ paletteName: 'sage' });
const COMPOSER_WIDTH = 50;

// The caret defaults to the end of whatever text a case supplies, because
// that is where typing leaves it -- a default of 0 would quietly make every
// case an "editing from the start" case.
const render = async (overrides: Partial<IComposerProps> = {}): Promise<TestRendererSetup> => {
  const props: IComposerProps = {
    text: '', mode: VimModes.NORMAL, focused: false, tokens, width: COMPOSER_WIDTH, replyingTo: null, editing: false,
    cursor: toGraphemes({ text: overrides.text ?? '' }).length, ...overrides,
  };
  const renderer = await renderWithKeys(<Composer {...props} />, { width: props.width, height: 2 });
  await renderer.flush();
  return renderer;
};

const readRows = (renderer: TestRendererSetup): string[] => {
  const lines = renderer.captureCharFrame().split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
};

test('shows a hint in normal mode when empty', async () => {
  expect((await render()).captureCharFrame()).toContain('press i to write');
});

test('shows the typed text in insert mode', async () => {
  expect((await render({ text: 'on my way', mode: VimModes.INSERT, focused: true })).captureCharFrame())
    .toContain('on my way');
});

// The caret used to be a `█` glyph appended after the text, which was fine
// while the end was the only place it could be. It is now a reversed cell, so
// it can sit *on* a letter without hiding it.
test('the caret is drawn as a reversed cell at the end of the draft', async () => {
  const renderer = await render({ text: 'hi', mode: VimModes.INSERT, focused: true });
  const spans = renderer.captureSpans().lines[0]!.spans;
  const caret = spans.find(span => rgbToHex(span.bg).toLowerCase() === tokens.modeInsert.toLowerCase());

  expect(caret).toBeDefined();
  expect(caret!.text).toBe(' ');
});

test('the caret sits on the letter it points at, which stays readable', async () => {
  const renderer = await render({ text: 'helo', cursor: 3, mode: VimModes.INSERT, focused: true });
  const spans = renderer.captureSpans().lines[0]!.spans;
  const caret = spans.find(span => rgbToHex(span.bg).toLowerCase() === tokens.modeInsert.toLowerCase());

  expect(caret!.text).toBe('o');
  expect(renderer.captureCharFrame()).toContain('helo');
});

// A caret drawn in normal mode would compete with the conversation's own
// cursorline, which is what shows position there.
test('no caret is drawn outside insert mode', async () => {
  const renderer = await render({ text: 'hi', mode: VimModes.NORMAL, focused: true });
  const highlighted = renderer.captureSpans().lines[0]!.spans
    .filter(span => rgbToHex(span.bg).toLowerCase() === tokens.modeInsert.toLowerCase());

  expect(highlighted).toEqual([]);
});

// The bug this whole caret exists to fix: with the caret at the start of a
// draft too long for the pane, the composer must show the start.
test('the visible window follows the caret rather than always showing the tail', async () => {
  const text = 'this message is a great deal longer than fifty columns of terminal will ever hold at once';
  const renderer = await render({ text, cursor: 0, mode: VimModes.INSERT, focused: true });
  const rows = readRows(renderer);

  expect(rows[0]!).toContain('this message is');
  expect(rows[0]!).not.toContain('at once');
  expect(rows[0]!.length).toBe(COMPOSER_WIDTH);
});

test('hides the hint once text has been typed', async () => {
  expect((await render({ text: 'hi' })).captureCharFrame()).not.toContain('press i to write');
});

test('always shows the prompt marker', async () => {
  expect((await render()).captureCharFrame()).toContain('❯');
});

// The owner's neovim sets fillchars="vert:│": splits are a single rule, not a
// box. Two bordered boxes meeting also drew a doubled `┐┌` seam, which is the
// visible cost of boxing anything here at all.
test('the prompt is the first row, and the composer draws no border of its own', async () => {
  const renderer = await render();
  const rows = readRows(renderer);
  expect(rows[0]).toContain('❯');

  const frame = renderer.captureCharFrame();
  for (const glyph of ['┌', '┐', '└', '┘', '│', '├', '┤', '─']) {
    expect({ glyph, present: frame.includes(glyph) }).toEqual({ glyph, present: false });
  }
});

// The rule this used to check is gone: M2's frame closes with a bottom edge
// directly above the composer, and two horizontal lines stacked read as a
// mistake rather than a separation. The composer draws no border of its own
// now, which the test above asserts.

// Two rows exactly. A composer that grows a third row when the text is long
// eats a row from the message view without telling it, and the panes above
// then have one more row of children than they have room for -- the same
// overflow that made the message view overdraw itself.
test('a line of text longer than the pane stays one row and keeps the tail in view', async () => {
  const text = 'this message is a great deal longer than fifty columns of terminal will ever hold at once';
  const renderer = await render({ text, mode: VimModes.INSERT, focused: true });
  const rows = readRows(renderer);
  expect(rows[0]!).toContain('at once');
  expect(rows[0]!.length).toBe(COMPOSER_WIDTH);
  expect(rows[0]!).not.toContain('this message is');
});

test('a wide-character message is measured in columns, not code points', async () => {
  const renderer = await render({
    text: '你好世界你好世界你好世界你好世界你好世界你好世界', mode: VimModes.INSERT, focused: true,
  });
  const rows = readRows(renderer);
  expect(renderer.captureSpans().lines[0]!.spans.reduce((total, span) => total + span.width, 0))
    .toBe(COMPOSER_WIDTH);
});

// Task 6: replying. No row appears at all when replyingTo is null (every test
// above relies on that default), so these are the only cases that see it.
test('no reply row when not replying', async () => {
  const renderer = await render({ replyingTo: null });
  const rows = readRows(renderer);
  expect(rows[0]).toContain('❯');
});

test('shows a dimmed reply preview above the prompt when replying', async () => {
  const renderer = await renderWithKeys(
    <Composer
      text="" cursor={0} mode={VimModes.NORMAL} focused={false} tokens={tokens} width={COMPOSER_WIDTH}
      replyingTo={{ senderName: 'Alice', text: 'sure, lets do it' }} editing={false}
    />,
    { width: COMPOSER_WIDTH, height: 3 },
  );
  await renderer.flush();
  const rows = readRows(renderer);
  expect(rows[0]).toContain('Replying to Alice: sure, lets do it');
  // The prompt is pushed down to make room -- the row above it changes, not
  // the row itself.
  expect(rows[1]).toContain('❯');

  const previewSpan = renderer.captureSpans().lines[0]!.spans[0]!;
  expect(rgbToHex(previewSpan.fg).toLowerCase()).toBe(tokens.dim.toLowerCase());
});

test('the reply preview shows only the first line, truncated to the composer width', async () => {
  const renderer = await renderWithKeys(
    <Composer
      text="" cursor={0} mode={VimModes.NORMAL} focused={false} tokens={tokens} width={COMPOSER_WIDTH}
      replyingTo={{ senderName: 'Alice', text: 'first line is already long enough to need truncating on its own\nsecond line' }}
      editing={false}
    />,
    { width: COMPOSER_WIDTH, height: 3 },
  );
  await renderer.flush();
  const rows = readRows(renderer);
  expect(rows[0]).not.toContain('second line');
  // Anchored on the literal prefix, not a bare `toContain('…')` -- the
  // prompt's own empty-composer hint ("press i to write…") already contains
  // an ellipsis, so that weaker assertion would pass even with this feature
  // entirely unimplemented and the row never inserted.
  expect(rows[0]!.startsWith('Replying to Alice: first line')).toBe(true);
  expect(rows[0]!.length).toBe(COMPOSER_WIDTH);
  expect(rows[0]!.endsWith('…')).toBe(true);
});

// Task 7: editing. No row appears at all when editing is false (every test
// above relies on that default), so these are the only cases that see it.
test('no editing row when not editing', async () => {
  const renderer = await render({ editing: false });
  const rows = readRows(renderer);
  expect(rows[0]).toContain('❯');
});

test('shows a dimmed editing indicator above the prompt when editing', async () => {
  const renderer = await renderWithKeys(
    <Composer
      text="fix the typo" cursor={12} mode={VimModes.INSERT} focused={true} tokens={tokens} width={COMPOSER_WIDTH}
      replyingTo={null} editing={true}
    />,
    { width: COMPOSER_WIDTH, height: 3 },
  );
  await renderer.flush();
  const rows = readRows(renderer);
  expect(rows[0]).toContain('Editing message');
  // The prompt is pushed down to make room -- the row above it changes, not
  // the row itself.
  expect(rows[1]).toContain('fix the typo');

  const indicatorSpan = renderer.captureSpans().lines[0]!.spans[0]!;
  expect(rgbToHex(indicatorSpan.fg).toLowerCase()).toBe(tokens.dim.toLowerCase());
});

// The two rows are independent props, so nothing stops both from being true
// at once (r then e in the same session) -- proving the stacking order here
// is deliberate, not just untested.
test('editing and a pending reply can show together, editing row on top', async () => {
  const renderer = await renderWithKeys(
    <Composer
      text="" cursor={0} mode={VimModes.NORMAL} focused={false} tokens={tokens} width={COMPOSER_WIDTH}
      replyingTo={{ senderName: 'Alice', text: 'sure, lets do it' }} editing={true}
    />,
    { width: COMPOSER_WIDTH, height: 5 },
  );
  await renderer.flush();
  const rows = readRows(renderer);
  expect(rows[0]).toContain('Editing message');
  expect(rows[1]).toContain('Replying to Alice: sure, lets do it');
  expect(rows[2]).toContain('❯');
});
