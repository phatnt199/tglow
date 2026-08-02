import { test, expect } from 'bun:test';

import { rgbToHex } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import { VimModes } from '../../../src/keys/common/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../src/tui/theme/index.ts';
import { Composer, type IComposerProps } from '../../../src/tui/panes/composer.tsx';

const tokens = buildTokens({ paletteName: 'sage' });
const COMPOSER_WIDTH = 50;

const render = async (overrides: Partial<IComposerProps> = {}): Promise<TestRendererSetup> => {
  const props: IComposerProps = {
    text: '', mode: VimModes.NORMAL, focused: false, tokens, width: COMPOSER_WIDTH, replyingTo: null, ...overrides,
  };
  const renderer = await renderWithKeys(<Composer {...props} />, { width: props.width, height: 3 });
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

test('shows a cursor block while in insert mode', async () => {
  expect((await render({ text: 'hi', mode: VimModes.INSERT, focused: true })).captureCharFrame()).toContain('█');
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
test('a single rule sits above the prompt, and no box anywhere', async () => {
  const renderer = await render();
  const rows = readRows(renderer);
  expect(rows[0]).toBe('─'.repeat(COMPOSER_WIDTH));
  expect(rows[1]).toContain('❯');

  const frame = renderer.captureCharFrame();
  for (const glyph of ['┌', '┐', '└', '┘', '│', '├', '┤']) {
    expect({ glyph, present: frame.includes(glyph) }).toEqual({ glyph, present: false });
  }
});

test('the rule is drawn in the border colour', async () => {
  const renderer = await render();
  const rule = renderer.captureSpans().lines[0]!.spans[0]!;
  expect(rule.text.startsWith('─')).toBe(true);
  expect(rgbToHex(rule.fg).toLowerCase()).toBe(tokens.border.toLowerCase());
});

// Two rows exactly. A composer that grows a third row when the text is long
// eats a row from the message view without telling it, and the panes above
// then have one more row of children than they have room for -- the same
// overflow that made the message view overdraw itself.
test('a line of text longer than the pane stays two rows and keeps the tail in view', async () => {
  const text = 'this message is a great deal longer than fifty columns of terminal will ever hold at once';
  const renderer = await render({ text, mode: VimModes.INSERT, focused: true });
  const rows = readRows(renderer);
  expect(rows.length).toBe(3);
  expect(rows[2]!.trim()).toBe('');
  expect(rows[1]!).toContain('at once');
  expect(rows[1]!.length).toBe(COMPOSER_WIDTH);
  expect(rows[1]!).not.toContain('this message is');
});

test('a wide-character message is measured in columns, not code points', async () => {
  const renderer = await render({
    text: '你好世界你好世界你好世界你好世界你好世界你好世界', mode: VimModes.INSERT, focused: true,
  });
  const rows = readRows(renderer);
  expect(rows.length).toBe(3);
  expect(rows[2]!.trim()).toBe('');
  expect(renderer.captureSpans().lines[1]!.spans.reduce((total, span) => total + span.width, 0))
    .toBe(COMPOSER_WIDTH);
});

// Task 6: replying. No row appears at all when replyingTo is null (every test
// above relies on that default), so these are the only cases that see it.
test('no reply row when not replying', async () => {
  const renderer = await render({ replyingTo: null });
  const rows = readRows(renderer);
  expect(rows[0]).toBe('─'.repeat(COMPOSER_WIDTH));
  expect(rows[1]).toContain('❯');
});

test('shows a dimmed reply preview above the prompt when replying', async () => {
  const renderer = await renderWithKeys(
    <Composer
      text="" mode={VimModes.NORMAL} focused={false} tokens={tokens} width={COMPOSER_WIDTH}
      replyingTo={{ senderName: 'Alice', text: 'sure, lets do it' }}
    />,
    { width: COMPOSER_WIDTH, height: 4 },
  );
  await renderer.flush();
  const rows = readRows(renderer);
  expect(rows[0]).toBe('─'.repeat(COMPOSER_WIDTH));
  expect(rows[1]).toContain('Replying to Alice: sure, lets do it');
  // The prompt is pushed down to make room -- the row above it changes, not
  // the row itself.
  expect(rows[2]).toContain('❯');

  const previewSpan = renderer.captureSpans().lines[1]!.spans[0]!;
  expect(rgbToHex(previewSpan.fg).toLowerCase()).toBe(tokens.dim.toLowerCase());
});

test('the reply preview shows only the first line, truncated to the composer width', async () => {
  const renderer = await renderWithKeys(
    <Composer
      text="" mode={VimModes.NORMAL} focused={false} tokens={tokens} width={COMPOSER_WIDTH}
      replyingTo={{ senderName: 'Alice', text: 'first line is already long enough to need truncating on its own\nsecond line' }}
    />,
    { width: COMPOSER_WIDTH, height: 4 },
  );
  await renderer.flush();
  const rows = readRows(renderer);
  expect(rows[1]).not.toContain('second line');
  // Anchored on the literal prefix, not a bare `toContain('…')` -- the
  // prompt's own empty-composer hint ("press i to write…") already contains
  // an ellipsis, so that weaker assertion would pass even with this feature
  // entirely unimplemented and the row never inserted.
  expect(rows[1]!.startsWith('Replying to Alice: first line')).toBe(true);
  expect(rows[1]!.length).toBe(COMPOSER_WIDTH);
  expect(rows[1]!.endsWith('…')).toBe(true);
});
