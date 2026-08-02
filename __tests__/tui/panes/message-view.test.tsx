import { test, expect } from 'bun:test';

import { rgbToHex, TextAttributes } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import type { IMessageRow } from '../../../src/core/cache/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../src/tui/theme/index.ts';
import { MessageView, type IMessageViewProps } from '../../../src/tui/panes/message-view.tsx';

const tokens = buildTokens({ paletteName: 'sage' });
const resolveSenderName = (opts: { fromId: string | null }): string =>
  opts.fromId === 'me' ? 'me' : 'Alice';

const messages: IMessageRow[] = [1, 2, 3, 4].map(id => ({
  peerId: 'u1', id, fromId: id === 3 ? 'me' : 'u1', date: id * 100, text: `msg${id}`, out: id === 3 ? 1 : 0,
  entities: [], replyToMessageId: null,
}));

// Zero-padded so no assertion can be satisfied by a substring of a different
// row: "msg1" appears inside "msg150", "msg001" appears inside nothing.
const HISTORY_LENGTH = 200;
const history: IMessageRow[] = Array.from({ length: HISTORY_LENGTH }, (unused, index) => ({
  peerId: 'u1',
  id: index + 1,
  fromId: 'u1',
  date: (index + 1) * 100,
  text: `msg${String(index + 1).padStart(3, '0')}`,
  out: 0,
  entities: [],
  replyToMessageId: null,
}));

// The rail, in display columns. Mirrors the constants in message-view.tsx:
// marker(1) gutter(4) space time(5) space sender(10) space.
const MARKER_COLUMNS = 1;
const GUTTER_COLUMNS = 4;
const RAIL_COLUMNS = 23;

const readGutter = (line: string): string =>
  line.slice(MARKER_COLUMNS, MARKER_COLUMNS + GUTTER_COLUMNS).trim();

const toHex = (colour: Parameters<typeof rgbToHex>[0]): string => rgbToHex(colour).toLowerCase();

interface ISpan {
  text: string;
  foreground: string;
  background: string;
  width: number;
  attributes: number;
}

const readSpans = (renderer: TestRendererSetup, row: number): ISpan[] =>
  (renderer.captureSpans().lines[row]?.spans ?? []).map(span => ({
    text: span.text,
    foreground: toHex(span.fg),
    background: toHex(span.bg),
    width: span.width,
    attributes: span.attributes,
  }));

const readRows = (renderer: TestRendererSetup): string[] => {
  const lines = renderer.captureCharFrame().split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
};

const render = async (
  overrides: Partial<IMessageViewProps> & { terminalWidth?: number; terminalHeight?: number } = {},
): Promise<TestRendererSetup> => {
  const { terminalWidth, terminalHeight, ...props } = overrides;
  const resolved: IMessageViewProps = {
    messages, cursor: 0, focused: true, tokens, height: 10, width: 50, resolveSenderName,
    revealedSpoilers: new Set(), ...props,
  };
  const renderer = await renderWithKeys(<MessageView {...resolved} />, {
    width: terminalWidth ?? resolved.width,
    height: terminalHeight ?? resolved.height,
  });
  await renderer.flush();
  return renderer;
};

test('shows sender and text for each message', async () => {
  const renderer = await render({ cursor: 3 });
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('msg1');
  expect(frame).toContain('msg4');
  expect(frame).toContain('Alice');
  expect(frame).toContain('me');
});

// The gutter is the fixed-width field between the marker column and the time.
// Reading it out is the point: `expect(lines[3]).toContain('4')` was satisfied
// by the text "msg4" further along the same line, so the cursor row's absolute
// number -- the one value that differs from every other row -- was never
// actually asserted.
test('the gutter shows relative distance, absolute on the cursor row', async () => {
  const renderer = await render({ cursor: 3 });
  const lines = readRows(renderer);
  expect(readGutter(lines[0]!)).toBe('3');
  expect(readGutter(lines[1]!)).toBe('2');
  expect(readGutter(lines[2]!)).toBe('1');
  expect(readGutter(lines[3]!)).toBe('4');
});

// Replaces the old `▸` assertion. The owner's neovim sets cursorlineopt="both",
// so the cursor row is a background across the whole row plus a highlighted
// number -- an arrow in column zero is the look those settings reject.
test('the cursor row is a background across the row and a gold gutter, not an arrow', async () => {
  const renderer = await render({ cursor: 1 });
  const spans = readSpans(renderer, 1);

  expect(spans[0]!.foreground).toBe(tokens.chatUnread.toLowerCase());
  expect(spans.map(span => span.background)).toEqual(spans.map(() => tokens.messageCursor.toLowerCase()));
  expect(spans.reduce((total, span) => total + span.width, 0)).toBe(50);

  expect(readSpans(renderer, 0).every(span => span.background !== tokens.messageCursor.toLowerCase())).toBe(true);
  expect(readSpans(renderer, 0)[0]!.foreground).toBe(tokens.dim.toLowerCase());
});

test('the marker column is reserved and blank on every row', async () => {
  const renderer = await render({ cursor: 1 });
  expect(renderer.captureCharFrame()).not.toContain('▸');
  for (const line of readRows(renderer)) {
    expect(line.slice(0, MARKER_COLUMNS)).toBe(' ');
  }
});

test('an unfocused pane draws no cursorline at all', async () => {
  const renderer = await render({ cursor: 1, focused: false });
  const spans = readSpans(renderer, 1);
  expect(spans.every(span => span.background !== tokens.messageCursor.toLowerCase())).toBe(true);
  expect(spans[0]!.foreground).toBe(tokens.dim.toLowerCase());
});

test('renders an empty history without crashing', async () => {
  const renderer = await render({ messages: [] });
  expect(renderer.captureCharFrame()).toContain('No messages');
});

// Final review, Critical 2: every row was rendered and nothing sliced to the
// pane's height, so with main.ts loading 200 messages into roughly ten rows
// the cursor moved through a list whose first screenful was the only part
// ever on screen. These three pin the window to the cursor at both ends and
// in the middle.
test('the visible window follows the cursor through a long history', async () => {
  const renderer = await render({ messages: history, cursor: 150 });
  const lines = readRows(renderer);
  const cursorLine = lines.findIndex(line => line.includes('msg151'));
  expect(cursorLine).toBeGreaterThanOrEqual(0);
  expect(readGutter(lines[cursorLine]!)).toBe('151');
  expect(readSpans(renderer, cursorLine)[0]!.background).toBe(tokens.messageCursor.toLowerCase());
});

test('the newest message is reachable at the end of a long history', async () => {
  const renderer = await render({ messages: history, cursor: HISTORY_LENGTH - 1 });
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('msg200');
  expect(frame).not.toContain('msg189');
});

test('the oldest message is on screen when the cursor is at 0', async () => {
  const renderer = await render({ messages: history, cursor: 0 });
  const lines = readRows(renderer);
  const cursorLine = lines.findIndex(line => line.includes('msg001'));
  expect(readGutter(lines[cursorLine]!)).toBe('1');
  expect(readSpans(renderer, cursorLine)[0]!.background).toBe(tokens.messageCursor.toLowerCase());
  expect(renderer.captureCharFrame()).not.toContain('msg011');
});

// The bug this pane was rebuilt around. Each message was one <text> that
// OpenTUI wrapped to as many rows as it needed, while the parent column
// allocated one row per child; when the children wanted more rows than the
// pane had, yoga shrank them instead of clipping, and the frame buffer
// interleaved their characters -- a real screenshot showed
// "This8cTelegrambLogindcodeo081289.oDoonotTgivertthisccodettoWanyone,".
//
// Every message here is one word repeated, at deliberately uneven lengths --
// even lengths shrink to exactly one row each and hide the fault. A row drawn
// from two messages cannot be a clean run of a single word.
const MARKERS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
const WORD_COUNTS = [3, 22, 5, 31, 9, 14, 2, 27, 6, 18, 11, 8];
const wordy: IMessageRow[] = MARKERS.map((marker, index) => ({
  peerId: 'u1',
  id: index + 1,
  fromId: `u${index}`,
  date: (index + 1) * 10_000,
  text: Array.from({ length: WORD_COUNTS[index]! }, () => marker).join(' '),
  out: 0,
  entities: [],
  replyToMessageId: null,
}));

// Rail characters only -- digits, colons and spaces -- so stripping it needs
// no knowledge of its width and the check holds across layout changes.
const RAIL_PATTERN = /^[\s0-9:-]*/;
const SINGLE_WORD_RUN = /^(?<word>[a-z]+)(?: \k<word>)*$/;

test('no rendered row draws two messages into the same line', async () => {
  const renderer = await render({
    messages: wordy, cursor: 0, height: 10, width: 70, resolveSenderName: () => '---',
  });
  for (const row of readRows(renderer)) {
    const content = row.trimEnd().replace(RAIL_PATTERN, '');
    if (content === '') {
      continue;
    }
    expect({ row, clean: SINGLE_WORD_RUN.test(content) }).toEqual({ row, clean: true });
  }
});

test('a pane far shorter than its content fills exactly its own height', async () => {
  const height = 10;
  const renderer = await render({ messages: wordy, cursor: 0, height, width: 70 });
  const rows = readRows(renderer);
  expect(rows.length).toBe(height);
  // Every row carries content: nothing overflowed off the bottom and no row
  // was wasted on a message that had been shrunk out of existence.
  expect(rows.filter(row => row.trim() !== '').length).toBe(height);
});

// Worst offender in the frame the owner sent: a wrapped line returned to
// column 0 and destroyed the column structure.
test('a wrapped line hangs at the content column instead of returning to column 0', async () => {
  const long = 'the quick brown fox jumps over the lazy dog and then keeps on running for a good while yet';
  const renderer = await render({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: long, out: 0, entities: [], replyToMessageId: null }],
    cursor: 0,
    width: 60,
    height: 8,
  });
  const rows = readRows(renderer);
  expect(rows[1]!.slice(0, RAIL_COLUMNS)).toBe(' '.repeat(RAIL_COLUMNS));
  expect(rows[1]![RAIL_COLUMNS]).not.toBe(' ');
  expect(rows[0]!.slice(RAIL_COLUMNS).trimEnd()).not.toBe('');
});

// Second offender: "Alice Nguyen" was cut to "Alice Ng" by a slice at eight
// characters, with nothing to say it had been cut.
test('a sender is given ten columns and is only ellipsised when genuinely longer', async () => {
  const renderer = await render({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'a', date: 100, text: 'short name', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'b', date: 100_000, text: 'long name', out: 0, entities: [], replyToMessageId: null },
    ],
    cursor: 0,
    resolveSenderName: opts => (opts.fromId === 'a' ? 'Alice Ng' : 'Alexandra Nguyen'),
    width: 60,
  });
  const rows = readRows(renderer);
  expect(rows[0]!.slice(12, 22)).toBe('Alice Ng  ');
  expect(rows[1]!.slice(12, 22)).toBe('Alexandra…');
});

test('consecutive messages from one sender show the name and time once', async () => {
  const grouped: IMessageRow[] = [
    { peerId: 'u1', id: 1, fromId: 'a', date: 1_000, text: 'first', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 2, fromId: 'a', date: 1_060, text: 'second', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 3, fromId: 'a', date: 1_120, text: 'third', out: 0, entities: [], replyToMessageId: null },
  ];
  const renderer = await render({ messages: grouped, cursor: 0, resolveSenderName: () => 'Alice' });
  const rows = readRows(renderer);
  expect(rows[0]!.slice(6, 22).trim()).not.toBe('');
  expect(rows[1]!.slice(6, 22)).toBe(' '.repeat(16));
  expect(rows[2]!.slice(6, 22)).toBe(' '.repeat(16));
  // Blanking the name must not blank the gutter -- the numbers are what 3j is read from.
  expect(readGutter(rows[1]!)).toBe('1');
  expect(readGutter(rows[2]!)).toBe('2');
});

test('a five minute gap starts a new group even from the same sender', async () => {
  const spaced: IMessageRow[] = [
    { peerId: 'u1', id: 1, fromId: 'a', date: 1_000, text: 'first', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 2, fromId: 'a', date: 1_000 + 299, text: 'still together', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 3, fromId: 'a', date: 1_000 + 600, text: 'new group', out: 0, entities: [], replyToMessageId: null },
  ];
  const renderer = await render({ messages: spaced, cursor: 0, resolveSenderName: () => 'Alice' });
  const rows = readRows(renderer);
  expect(rows[1]!.slice(6, 22)).toBe(' '.repeat(16));
  expect(rows[2]!.slice(12, 22)).toBe('Alice     ');
});

test('the time column is HH:MM in local time', async () => {
  const at = new Date(2026, 7, 1, 9, 14, 0);
  const renderer = await render({
    messages: [{
      peerId: 'u1', id: 1, fromId: 'a', date: Math.floor(at.getTime() / 1000), text: 'hello', out: 0,
      entities: [], replyToMessageId: null,
    }],
    cursor: 0,
    resolveSenderName: () => 'Alice',
  });
  expect(readRows(renderer)[0]!.slice(6, 11)).toBe('09:14');
});

test('an own message is drawn in the own-message colour', async () => {
  const renderer = await render({ cursor: 0 });
  const own = readSpans(renderer, 2);
  const theirs = readSpans(renderer, 0);
  expect(own[own.length - 1]!.foreground).toBe(tokens.messageOwn.toLowerCase());
  expect(theirs[theirs.length - 1]!.foreground).toBe(tokens.messageOther.toLowerCase());
});

// A name measured with .length would leave the content column two cells out of
// line for every wide glyph in it, which is how a rail stops being a rail.
test('a wide or decomposed sender name keeps the content column aligned', async () => {
  const mixed: IMessageRow[] = [
    { peerId: 'u1', id: 1, fromId: 'a', date: 1_000, text: 'plain', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 2, fromId: 'b', date: 100_000, text: 'wide', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 3, fromId: 'c', date: 200_000, text: 'decomposed', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 4, fromId: 'd', date: 300_000, text: 'emoji', out: 0, entities: [], replyToMessageId: null },
  ];
  const names: Record<string, string> = {
    a: 'Alice', b: '张伟同学', c: 'Đức anh hoàng'.normalize('NFD'), d: '🔥 Em Việt Tú',
  };
  const renderer = await render({
    messages: mixed,
    cursor: 0,
    resolveSenderName: opts => names[opts.fromId ?? 'a']!,
    width: 60,
  });

  // The content span is the last one on the row and starts where the rail
  // ends, so its width is what the rail cost -- whatever script the name is
  // written in. Measured with .length, a four-ideograph name would push it
  // four columns wide of everything above it.
  const PANE_WIDTH = 60;
  for (let row = 0; row < mixed.length; row += 1) {
    const spans = readSpans(renderer, row);
    const content = spans[spans.length - 1]!;
    expect({ row, content: content.width, total: spans.reduce((sum, span) => sum + span.width, 0) }).toEqual({
      row,
      content: PANE_WIDTH - RAIL_COLUMNS,
      total: PANE_WIDTH,
    });
  }
});

test('a message carrying newlines still renders one row per line', async () => {
  const renderer = await render({
    messages: [{
      peerId: 'u1', id: 1, fromId: 'a', date: 100, text: 'first\nsecond\nthird', out: 0,
      entities: [], replyToMessageId: null,
    }],
    cursor: 0,
    width: 60,
    height: 6,
  });
  const rows = readRows(renderer);
  expect(rows[0]!.slice(RAIL_COLUMNS).trimEnd()).toBe('first');
  expect(rows[1]!.slice(RAIL_COLUMNS).trimEnd()).toBe('second');
  expect(rows[2]!.slice(RAIL_COLUMNS).trimEnd()).toBe('third');
});

// A resized terminal can leave the pane narrower than its own rail. The rail
// is fixed by design, so the row overruns -- but it must overrun into the
// clip, not into the row below it.
test('a pane narrower than its own rail still renders exactly one row per line', async () => {
  const renderer = await render({ messages: wordy, cursor: 0, width: 12, height: 6, resolveSenderName: () => '---' });
  const rows = readRows(renderer);
  expect(rows.length).toBe(6);
  for (const row of rows) {
    const content = row.trimEnd().replace(RAIL_PATTERN, '');
    expect({ row, clean: content === '' || SINGLE_WORD_RUN.test(content) }).toEqual({ row, clean: true });
  }
});

// A message taller than the pane used to push its own start off the top,
// leaving the cursor on a row nothing identified.
test('a message taller than the pane is anchored at its first row', async () => {
  const wall = Array.from({ length: 200 }, (unused, index) => `word${index}`).join(' ');
  const renderer = await render({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'a', date: 100, text: 'before', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'a', date: 200, text: wall, out: 0, entities: [], replyToMessageId: null },
    ],
    cursor: 1,
    width: 60,
    height: 6,
  });
  const rows = readRows(renderer);
  expect(readGutter(rows[0]!)).toBe('2');
  expect(rows[0]!).toContain('word0');
  expect(rows.length).toBe(6);
});

// Task 4: entities render as themselves instead of plain characters.
//
// `revealedSpoilers` is added explicitly to every case here, including the
// two the brief's own snippet omits it from (the link and long-wrap tests) --
// the prop has no default in IMessageViewProps precisely so a call site
// cannot forget it, and that has to hold for these call sites too or the
// omission would be a typecheck failure, not a passing test.

test('a link renders its text, and the URL is not printed inline', async () => {
  const messages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'see here', entities: [{ kind: 'textUrl', offset: 4, length: 4, url: 'https://example.com' }],
  }];
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={0} focused tokens={tokens} height={6} width={50}
                 resolveSenderName={resolveSenderName} revealedSpoilers={new Set()} />,
    { width: 50, height: 6 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('see here');
  expect(frame).not.toContain('https://example.com');
});

test('a link is coloured with textLink and underlined', async () => {
  const messages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'see here', entities: [{ kind: 'textUrl', offset: 4, length: 4, url: 'https://example.com' }],
  }];
  const renderer = await render({ messages, cursor: 0, width: 50, height: 6 });
  const spans = readSpans(renderer, 0);
  const linkSpan = spans.find(span => span.text === 'here');
  expect(linkSpan?.foreground).toBe(tokens.textLink.toLowerCase());
  expect(((linkSpan?.attributes ?? 0) & TextAttributes.UNDERLINE) !== 0).toBe(true);
});

test('a spoiler is hidden until revealed', async () => {
  const messages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'the answer is 42', entities: [{ kind: 'spoiler', offset: 14, length: 2 }],
  }];
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={0} focused tokens={tokens} height={6} width={50}
                 resolveSenderName={resolveSenderName} revealedSpoilers={new Set()} />,
    { width: 50, height: 6 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).not.toContain('42');
  expect(renderer.captureCharFrame()).toContain('█');
});

test('a revealed spoiler shows its text', async () => {
  const messages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'the answer is 42', entities: [{ kind: 'spoiler', offset: 14, length: 2 }],
  }];
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={0} focused tokens={tokens} height={6} width={50}
                 resolveSenderName={resolveSenderName} revealedSpoilers={new Set([1])} />,
    { width: 50, height: 6 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('42');
});

// A CJK ideograph is one UTF-16 code unit but two display columns (the same
// divergence text-width.ts's own tests are built around). Masking by
// `.length` would count it as one and leave the block a column short,
// dragging every column after it out of line with the rows above and below;
// masking by display width gets the full four columns of "中AB" right.
test('a spoiler mask is as wide as the hidden text, not as long', async () => {
  const messages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'secret 中AB done', entities: [{ kind: 'spoiler', offset: 7, length: 3 }],
  }];
  const renderer = await render({ messages, cursor: 0, revealedSpoilers: new Set(), width: 50, height: 6 });
  const spans = readSpans(renderer, 0);
  const masked = spans.find(span => span.text.startsWith('█'));
  expect(masked?.text).toBe('████');
  expect(masked?.width).toBe(4);
});

test('a code span is coloured with textCode', async () => {
  const messages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'run npm test now', entities: [{ kind: 'code', offset: 4, length: 8 }],
  }];
  const renderer = await render({ messages, cursor: 0, width: 50, height: 6 });
  const spans = readSpans(renderer, 0);
  const codeSpan = spans.find(span => span.text === 'npm test');
  expect(codeSpan?.foreground).toBe(tokens.textCode.toLowerCase());
});

test('a bold span carries the bold attribute', async () => {
  const messages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'very bold move', entities: [{ kind: 'bold', offset: 5, length: 4 }],
  }];
  const renderer = await render({ messages, cursor: 0, width: 50, height: 6 });
  const spans = readSpans(renderer, 0);
  const boldSpan = spans.find(span => span.text === 'bold');
  expect(boldSpan).toBeDefined();
  expect((boldSpan!.attributes & TextAttributes.BOLD) !== 0).toBe(true);
});

test('a long styled message wraps into the content column, not to column zero', async () => {
  const long = 'this is a deliberately long message that must wrap more than once inside the pane';
  const messages: IMessageRow[] = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: long, entities: [{ kind: 'bold', offset: 0, length: 4 }],
  }];
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={0} focused tokens={tokens} height={8} width={50}
                 resolveSenderName={resolveSenderName} revealedSpoilers={new Set()} />,
    { width: 50, height: 8 },
  );
  await renderer.flush();
  const lines = renderer.captureCharFrame().split('\n').filter(line => line.trim() !== '');
  expect(lines.length).toBeGreaterThan(1);
  // Continuation rows are indented to the content column, never flush left.
  for (const line of lines.slice(1)) {
    expect(line.startsWith(' ')).toBe(true);
  }
});

// wrapSpans has no concept of a line break on its own (__tests__/tui/wrap-spans.test.ts
// documents that boundary); message-view.tsx has to split on '\n' itself
// before wrapping, the same job wrapText's toLogicalLines already did for the
// plain-text path this replaces.
test('a styled message carrying newlines still renders one row per line', async () => {
  const renderer = await render({
    messages: [{
      peerId: 'u1', id: 1, fromId: 'a', date: 100, text: 'first\nsecond\nthird', out: 0,
      entities: [{ kind: 'bold', offset: 0, length: 5 }], replyToMessageId: null,
    }],
    cursor: 0,
    width: 60,
    height: 6,
  });
  const rows = readRows(renderer);
  expect(rows[0]!.slice(RAIL_COLUMNS).trimEnd()).toBe('first');
  expect(rows[1]!.slice(RAIL_COLUMNS).trimEnd()).toBe('second');
  expect(rows[2]!.slice(RAIL_COLUMNS).trimEnd()).toBe('third');
});

// Mirrors wrapText's own tab handling (src/tui/wrap-text.ts's toLogicalLines):
// a raw tab reaching the terminal would expand at its own tab stop and desync
// the column the rail depends on, so message-view.tsx normalises it to a
// single space on the styled path the same way wrapText already did on the
// plain-text path it replaces.
// Task 6: reply. A quote row sits above any message carrying a
// replyToMessageId, so it must line up at the same content column as every
// other row here -- see the wrapped-continuation test above for the bug this
// guards against if it does not.
test('a message with a reply target shows a dimmed quote row above it, at the content column', async () => {
  const withReply: IMessageRow[] = [
    { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'original text here', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 2, fromId: 'me', date: 200, text: 'my reply', out: 1, entities: [], replyToMessageId: 1 },
  ];
  const renderer = await render({ messages: withReply, cursor: 1, width: 60, height: 8 });
  const rows = readRows(renderer);
  const quoteRowIndex = rows.findIndex(row => row.includes('Replying to'));
  expect(quoteRowIndex).toBeGreaterThanOrEqual(0);
  expect(rows[quoteRowIndex]).toContain('Replying to Alice: original text here');
  expect(rows[quoteRowIndex]!.slice(0, RAIL_COLUMNS)).toBe(' '.repeat(RAIL_COLUMNS));

  const spans = readSpans(renderer, quoteRowIndex);
  expect(spans[spans.length - 1]!.foreground).toBe(tokens.dim.toLowerCase());
});

test('a reply target outside the currently held history shows a generic fallback', async () => {
  const orphanReply: IMessageRow[] = [
    { peerId: 'u1', id: 5, fromId: 'u1', date: 500, text: 'reply to nothing loaded', out: 0, entities: [], replyToMessageId: 999 },
  ];
  const renderer = await render({ messages: orphanReply, cursor: 0, width: 60 });
  expect(renderer.captureCharFrame()).toContain('Replying to an earlier message');
});

test('a message with no reply target shows no quote row', async () => {
  const renderer = await render({ cursor: 0 });
  expect(renderer.captureCharFrame()).not.toContain('Replying to');
});

// The quote row shares its message's messageIndex, so it must be swept into
// the same cursorline highlight as the rest of that message -- exactly how a
// wrapped continuation row already is.
test('the quote row is highlighted along with the rest of the cursor message', async () => {
  const withReply: IMessageRow[] = [
    { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'original', out: 0, entities: [], replyToMessageId: null },
    { peerId: 'u1', id: 2, fromId: 'me', date: 200, text: 'my reply', out: 1, entities: [], replyToMessageId: 1 },
  ];
  const renderer = await render({ messages: withReply, cursor: 1, width: 60, height: 8, focused: true });
  const rows = readRows(renderer);
  const quoteRowIndex = rows.findIndex(row => row.includes('Replying to'));
  // Asserted explicitly, not just implied by the spans check below: an
  // `every()` over the empty array readSpans(renderer, -1) returns would
  // otherwise pass vacuously if the quote row were missing entirely, proving
  // nothing about highlighting at all.
  expect(quoteRowIndex).toBeGreaterThanOrEqual(0);
  const spans = readSpans(renderer, quoteRowIndex);
  expect(spans.length).toBeGreaterThan(0);
  expect(spans.every(span => span.background === tokens.messageCursor.toLowerCase())).toBe(true);
});

test('a tab in a message becomes a single space', async () => {
  const renderer = await render({
    messages: [{
      peerId: 'u1', id: 1, fromId: 'a', date: 100, text: 'a\tb', out: 0,
      entities: [], replyToMessageId: null,
    }],
    cursor: 0,
    width: 60,
    height: 6,
  });
  const rows = readRows(renderer);
  expect(rows[0]!.slice(RAIL_COLUMNS).trimEnd()).toBe('a b');
});
