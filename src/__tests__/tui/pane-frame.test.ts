import { test, expect } from 'bun:test';

import {
  FRAME_HORIZONTAL_COST,
  buildBottomEdge,
  buildTopEdge,
  resolvePaneWidths,
} from '../../tui/pane-frame.ts';
import { measureTextWidth } from '../../tui/text-width.ts';

const widthsFor = (width: number, sidebarWidth = 22): ReturnType<typeof resolvePaneWidths> =>
  resolvePaneWidths({ width, sidebarWidth, minimumPane: 16 });

// The arithmetic that, got wrong, produced M1a's interleaved-text report: a
// frame row that is not exactly the window's width stops lining up with the
// panes underneath it, and the panes overdraw each other's cells.
test('every frame row is exactly the window width', () => {
  for (const width of [40, 60, 80, 120, 200]) {
    const widths = widthsFor(width);
    const titles = { sidebar: 'Chats', messages: 'Alice' };
    expect(measureTextWidth({ text: buildTopEdge({ widths, titles }) }), `top @${width}`).toBe(width);
    expect(measureTextWidth({ text: buildBottomEdge({ widths }) }), `bottom @${width}`).toBe(width);
  }
});

test('the panes and the frame together account for every column', () => {
  for (const width of [40, 60, 80, 120]) {
    const widths = widthsFor(width);
    expect(widths.sidebar + widths.messages + FRAME_HORIZONTAL_COST, `@${width}`).toBe(width);
  }
});

test('the titles appear in the top edge', () => {
  const edge = buildTopEdge({ widths: widthsFor(80), titles: { sidebar: 'Chats', messages: 'Alice' } });
  expect(edge).toContain('─ Chats ');
  expect(edge).toContain('─ Alice ');
  expect(edge.startsWith('┌')).toBe(true);
  expect(edge.endsWith('┐')).toBe(true);
});

// One junction, not a `┐┌` seam -- M1a boxed each pane separately and got the
// doubled corner, which is why RULE_WIDTH's comment says splits are a rule.
test('the panes meet at a single junction, never a doubled corner', () => {
  const top = buildTopEdge({ widths: widthsFor(80), titles: { sidebar: 'Chats', messages: 'Alice' } });
  expect(top).toContain('┬');
  expect(top).not.toContain('┐┌');
  expect(top.split('┬')).toHaveLength(2);

  const bottom = buildBottomEdge({ widths: widthsFor(80) });
  expect(bottom).toContain('┴');
  expect(bottom).not.toContain('┘└');
});

// A wide title must not push the junction sideways, or the edge stops agreeing
// with the panes below it.
test('a title too long for its pane is truncated, not allowed to widen it', () => {
  const widths = widthsFor(60);
  const edge = buildTopEdge({
    widths,
    titles: { sidebar: 'Chats', messages: 'a chat whose title runs on far past the pane it belongs to' },
  });
  expect(measureTextWidth({ text: edge })).toBe(60);
  expect(edge.endsWith('┐')).toBe(true);
});

// Vietnamese and CJK titles are two columns per glyph in places; measuring by
// code point would let them overflow.
test('a wide-character title still leaves the edge exactly the window width', () => {
  const widths = widthsFor(60);
  for (const title of ['Nguyễn Tấn Phát', '张伟同学', '🔥 Em Việt Tú']) {
    const edge = buildTopEdge({ widths, titles: { sidebar: 'Chats', messages: title } });
    expect(measureTextWidth({ text: edge }), title).toBe(60);
  }
});

test('neither pane can be squeezed out of existence', () => {
  for (const width of [40, 60, 80, 120]) {
    const widths = widthsFor(width, 22);
    expect(widths.sidebar, `sidebar @${width}`).toBeGreaterThanOrEqual(16);
    expect(widths.messages, `messages @${width}`).toBeGreaterThanOrEqual(16);
  }
});

// A divider dragged to the far right, or a sidebar width left over from a
// wider window, must not leave the message pane one column wide.
test('an absurd sidebar width is clamped so the message pane survives', () => {
  const widths = resolvePaneWidths({ width: 80, sidebarWidth: 500, minimumPane: 16 });
  expect(widths.messages).toBeGreaterThanOrEqual(16);
  expect(widths.sidebar + widths.messages + FRAME_HORIZONTAL_COST).toBe(80);
});

test('a sidebar width below the minimum is raised to it', () => {
  expect(resolvePaneWidths({ width: 80, sidebarWidth: 2, minimumPane: 16 }).sidebar).toBe(16);
});

// Below the point where both minimums fit, something has to give. The sidebar
// gives way first: a one-column message pane is useless, and the chat list is
// the pane you can navigate without.
//
// The first version of this test asserted only that neither pane went negative
// and the columns added up -- both of which were true of an implementation
// that did the OPPOSITE, handing a 30-column window a 22-wide chat list and
// five columns of conversation. Asserting the intent is what caught it.
test('a narrow window feeds the message pane first, not the sidebar', () => {
  const widths = widthsFor(30, 22);
  expect(widths.messages).toBeGreaterThanOrEqual(widths.sidebar);
  expect(widths.messages).toBe(16);
  expect(widths.sidebar).toBe(11);
});

test('a window too narrow for both minimums still divides without going negative', () => {
  for (const width of [1, 5, 12, 20, 30]) {
    const widths = widthsFor(width);
    expect(widths.sidebar, `sidebar @${width}`).toBeGreaterThanOrEqual(0);
    expect(widths.messages, `messages @${width}`).toBeGreaterThanOrEqual(0);
    expect(
      widths.sidebar + widths.messages + FRAME_HORIZONTAL_COST,
      `total @${width}`,
    ).toBeLessThanOrEqual(Math.max(width, FRAME_HORIZONTAL_COST));
  }
});
