# tglow M1b-1 — the message layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Links, bold and `code` render as themselves; you can reply, edit and delete; messages you read are marked read and your own show ticks; and messages sent while tglow was closed are backfilled instead of lost.

**Architecture:** No new units. A pure `src/tui/entities.ts` converts Telegram's UTF-16 entity offsets into styled spans over graphemes; `wrap-text.ts` gains a span-aware path; the message view renders spans. `MessageService` gains reply/edit/delete/mark-read. A new `DifferenceService` owns `pts` state and gap recovery, feeding the same path live updates already use.

**Tech Stack:** Bun · TypeScript 7.0.2 · `@venizia/ignis-inversion` · `@opentui/react` · GramJS · Drizzle over `bun:sqlite`

Implements §3 of `docs/superpowers/specs/2026-08-02-tglow-m1b-design.md`.

## Global Constraints

- **Read `docs/superpowers/conventions/ignis-style.md` first.** Binding on every file.
- Arrow functions only; named exports only; explicit return types; options object `opts` except a single fully-typed domain object; `I` prefix on interfaces, `T` on type aliases; kebab-case files; private data fields `_`-prefixed, private methods not; **never abbreviate**.
- Never `new Error` in production code — `getError({ message: '[Class][method] …' })`. Every `catch` logs first through the scoped logger. Every `switch` has braces per case and a `default`.
- Dependency rule, enforced by `__tests__/boundaries.test.ts`: `keys/` imports only `@venizia/ignis-inversion` and relative paths; `core/` never `react` or `@opentui/*`; `tui/` never `telegram`.
- **No commit message may contain Claude or Anthropic attribution.** No `Co-Authored-By` trailer.
- Tests live under `__tests__/` mirroring `src/`. Never under `src/`.
- **Simulated key presses must be wrapped in React's `act()`**, and a lone Escape needs the parser's timeout — use the existing `pressEscape` helper in `__tests__/tui/app.test.tsx`.
- `bun test` green, `bun run typecheck` clean, and `bun test 2>&1 | grep -ciE 'MaxListeners|not wrapped in act'` must be 0.
- Commit after every task.

## Existing interfaces you will extend

```ts
// src/core/message-service.ts
interface IRawMessage { id: number; peerId: string; fromId: string | null; date: number; text: string; out: number; }
interface IMessageAdapter {
  fetchHistory(opts: { peerId: string; limit: number }): Promise<IRawMessage[]>;
  send(opts: { peerId: string; text: string }): Promise<IRawMessage>;
  subscribeToNewMessages(opts: { onMessage: (message: IRawMessage) => void }): () => void;
}
// src/core/cache/database.ts
interface IMessageRow { peerId: string; id: number; fromId: string | null; date: number; text: string; out: number; }
// src/tui/text-width.ts
toGraphemes(opts: { text: string }): { grapheme: string; width: number }[]
measureTextWidth(opts: { text: string }): number
// src/tui/wrap-text.ts
wrapText(opts: { text: string; width: number }): string[]
```

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/common/entity-types.ts` | `ITelegramEntity`, `TEntityKind` — shared by core and tui |
| `src/tui/entities.ts` | **new** — entities → styled spans. Pure. |
| `src/tui/wrap-spans.ts` | **new** — span-aware wrapping |
| `src/tui/panes/message-view.tsx` | render spans, quote lines, ticks |
| `src/core/telegram-adapter.ts` | capture entities, reply ids, edit/delete/read calls |
| `src/core/message-service.ts` | reply, edit, delete, mark-as-read |
| `src/core/difference-service.ts` | **new** — `pts` state and gap recovery |
| `src/keys/keymap.ts` | `r`, `e`, `dd`, `zs`, `y`/`n` |
| `src/tui/action-reducer.ts` | reply target, editing state, spoiler reveals, confirmation |

---

### Task 1: Entity types, captured instead of discarded

**Files:**
- Create: `src/core/common/entity-types.ts`
- Modify: `src/core/common/index.ts`, `src/core/telegram-adapter.ts`, `src/core/message-service.ts` (`IRawMessage`), `src/core/cache/database.ts` (`IMessageInput`, `IMessageRow`)
- Test: `__tests__/core/cache/database.test.ts` (extend)

**Interfaces:**
- Consumes: nothing
- Produces: `ITelegramEntity { kind: TEntityKind; offset: number; length: number; url?: string }`, `TEntityKind`; `IRawMessage` and `IMessageRow` gain `entities: ITelegramEntity[]` and `replyToMessageId: number | null`.

- [ ] **Step 1: Write `src/core/common/entity-types.ts`**

```ts
/** Telegram message entity kinds tglow renders. Unknown kinds arrive as 'unknown'. */
export class EntityKinds {
  static readonly BOLD = 'bold';
  static readonly ITALIC = 'italic';
  static readonly UNDERLINE = 'underline';
  static readonly STRIKE = 'strike';
  static readonly CODE = 'code';
  static readonly PRE = 'pre';
  static readonly SPOILER = 'spoiler';
  static readonly URL = 'url';
  static readonly TEXT_URL = 'textUrl';
  static readonly MENTION = 'mention';
  static readonly HASHTAG = 'hashtag';
  static readonly UNKNOWN = 'unknown';
}

export type TEntityKind = (typeof EntityKinds)[Exclude<keyof typeof EntityKinds, 'prototype'>];

/**
 * `offset` and `length` are in UTF-16 code units, as Telegram sends them. They
 * are NOT grapheme or column indices — converting is `src/tui/entities.ts`'s job
 * and indexing the raw string with them directly will split emoji.
 */
export interface ITelegramEntity {
  kind: TEntityKind;
  offset: number;
  length: number;
  url?: string;
}
```

Export it from `src/core/common/index.ts`.

- [ ] **Step 2: Widen the message shapes**

Add to `IRawMessage` (in `src/core/message-service.ts`), `IMessageInput` and `IMessageRow` (in `src/core/cache/database.ts`):

```ts
  entities: ITelegramEntity[];
  replyToMessageId: number | null;
```

In the cache, `entities` persists as JSON in the existing `entities` column and `replyToMessageId` in the existing `reply_to_msg_id` column — both already in the schema and currently never written. Serialise with `JSON.stringify` on write and parse on read, defaulting to `[]` and `null` when the column is null.

- [ ] **Step 3: Write the failing cache test**

Append to `__tests__/core/cache/database.test.ts`:

```ts
test('entities and reply id round-trip through the cache', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [{
      peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'see docs', out: 0,
      entities: [{ kind: 'textUrl', offset: 4, length: 4, url: 'https://example.com' }],
      replyToMessageId: 7,
    }],
  });
  const [row] = database.listMessages({ peerId: 'u1', limit: 10 });
  expect(row!.entities).toEqual([{ kind: 'textUrl', offset: 4, length: 4, url: 'https://example.com' }]);
  expect(row!.replyToMessageId).toBe(7);
  database.close();
});

test('a message with no entities reads back as an empty array, not null', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'plain', out: 0, entities: [], replyToMessageId: null }],
  });
  const [row] = database.listMessages({ peerId: 'u1', limit: 10 });
  expect(row!.entities).toEqual([]);
  expect(row!.replyToMessageId).toBeNull();
  database.close();
});
```

- [ ] **Step 4: Run and watch it fail**

Run: `bun test __tests__/core/cache/database.test.ts`
Expected: FAIL — the properties do not exist.

- [ ] **Step 5: Capture entities in the adapter**

In `src/core/telegram-adapter.ts`, map GramJS's entity classes to `TEntityKind`. GramJS names them `MessageEntityBold`, `MessageEntityTextUrl` and so on, on `message.entities`. Read the actual class names from `node_modules/telegram/tl/custom/message.d.ts` and the generated API types rather than guessing — an unrecognised name must map to `EntityKinds.UNKNOWN`, never throw.

```ts
const toEntityKind = (opts: { className: string }): TEntityKind => {
  switch (opts.className) {
    case 'MessageEntityBold': { return EntityKinds.BOLD; }
    case 'MessageEntityItalic': { return EntityKinds.ITALIC; }
    case 'MessageEntityUnderline': { return EntityKinds.UNDERLINE; }
    case 'MessageEntityStrike': { return EntityKinds.STRIKE; }
    case 'MessageEntityCode': { return EntityKinds.CODE; }
    case 'MessageEntityPre': { return EntityKinds.PRE; }
    case 'MessageEntitySpoiler': { return EntityKinds.SPOILER; }
    case 'MessageEntityUrl': { return EntityKinds.URL; }
    case 'MessageEntityTextUrl': { return EntityKinds.TEXT_URL; }
    case 'MessageEntityMention': { return EntityKinds.MENTION; }
    case 'MessageEntityHashtag': { return EntityKinds.HASHTAG; }
    default: { return EntityKinds.UNKNOWN; }
  }
};
```

Extract a single `toRawMessage` used by `fetchHistory`, `send` and `subscribeToNewMessages`, so a fetched, sent and live message cannot diverge — they already nearly did over `peerId`.

- [ ] **Step 6: Run tests and typecheck**

```bash
bun test
bun run typecheck
```

Expected: green. Every construction site of `IRawMessage`/`IMessageInput` in tests will need the two new fields — add them rather than making the fields optional. Optional fields here would let a caller silently drop entities, which is the bug this task exists to fix.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Capture message entities instead of discarding them

The adapter reduced every message to plain text, so a link, bold or code
span reached the interface as unstyled characters. The schema has had an
entities column since M1a and nothing ever wrote it."
```

---

### Task 2: Entities to styled spans

The hard part of this milestone. Telegram offsets are UTF-16; tglow measures in
graphemes. Getting this wrong splits emoji and mis-places styles on exactly the
text this user writes.

**Files:**
- Create: `src/tui/entities.ts`
- Test: `__tests__/tui/entities.test.ts`

**Interfaces:**
- Consumes: `ITelegramEntity`, `EntityKinds`; `toGraphemes` from `src/tui/text-width.ts`
- Produces: `IStyledSpan { text: string; kinds: TEntityKind[]; url: string | null }`, `toStyledSpans(opts: { text: string; entities: ITelegramEntity[] }): IStyledSpan[]`

- [ ] **Step 1: Write the failing test**

`__tests__/tui/entities.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { EntityKinds } from '../../src/core/common/index.ts';
import { toStyledSpans } from '../../src/tui/entities.ts';

test('text with no entities is one plain span', () => {
  expect(toStyledSpans({ text: 'hello', entities: [] }))
    .toEqual([{ text: 'hello', kinds: [], url: null }]);
});

test('a single entity splits the text into three spans', () => {
  expect(toStyledSpans({ text: 'say hi now', entities: [{ kind: EntityKinds.BOLD, offset: 4, length: 2 }] }))
    .toEqual([
      { text: 'say ', kinds: [], url: null },
      { text: 'hi', kinds: [EntityKinds.BOLD], url: null },
      { text: ' now', kinds: [], url: null },
    ]);
});

test('an entity at the very start and one at the very end are both kept', () => {
  const spans = toStyledSpans({
    text: 'ab', entities: [
      { kind: EntityKinds.BOLD, offset: 0, length: 1 },
      { kind: EntityKinds.ITALIC, offset: 1, length: 1 },
    ],
  });
  expect(spans).toEqual([
    { text: 'a', kinds: [EntityKinds.BOLD], url: null },
    { text: 'b', kinds: [EntityKinds.ITALIC], url: null },
  ]);
});

// Telegram genuinely sends these — bold inside a link is ordinary.
test('overlapping entities flatten into spans carrying both kinds', () => {
  const spans = toStyledSpans({
    text: 'abcd', entities: [
      { kind: EntityKinds.TEXT_URL, offset: 0, length: 4, url: 'https://example.com' },
      { kind: EntityKinds.BOLD, offset: 1, length: 2 },
    ],
  });
  expect(spans.map(span => span.text)).toEqual(['a', 'bc', 'd']);
  expect(spans[1]!.kinds.sort()).toEqual([EntityKinds.BOLD, EntityKinds.TEXT_URL].sort());
  expect(spans[0]!.url).toBe('https://example.com');
});

// The whole reason this module exists. An emoji is 2 UTF-16 code units and one
// grapheme; indexing the raw string by a Telegram offset would split it.
test('offsets are UTF-16, so an emoji before an entity does not shift it', () => {
  const text = '🔥 hi';                       // 🔥 is 2 code units, then ' hi'
  const spans = toStyledSpans({ text, entities: [{ kind: EntityKinds.BOLD, offset: 3, length: 2 }] });
  expect(spans.map(span => span.text).join('')).toBe(text);
  expect(spans.find(span => span.kinds.includes(EntityKinds.BOLD))!.text).toBe('hi');
});

test('an entity covering an emoji keeps the emoji whole', () => {
  const text = 'a🔥b';
  const spans = toStyledSpans({ text, entities: [{ kind: EntityKinds.BOLD, offset: 1, length: 2 }] });
  expect(spans.map(span => span.text).join('')).toBe(text);
  expect(spans.find(span => span.kinds.includes(EntityKinds.BOLD))!.text).toBe('🔥');
});

test('combining marks are not split', () => {
  const text = 'Việt Nam';                     // ệ may arrive decomposed
  const spans = toStyledSpans({ text, entities: [{ kind: EntityKinds.BOLD, offset: 0, length: 4 }] });
  expect(spans.map(span => span.text).join('')).toBe(text);
});

test('an unknown entity kind passes through as plain text rather than throwing', () => {
  const spans = toStyledSpans({ text: 'hello', entities: [{ kind: EntityKinds.UNKNOWN, offset: 0, length: 5 }] });
  expect(spans.map(span => span.text).join('')).toBe('hello');
});

test('an entity running past the end of the text is clamped', () => {
  const spans = toStyledSpans({ text: 'hi', entities: [{ kind: EntityKinds.BOLD, offset: 0, length: 99 }] });
  expect(spans.map(span => span.text).join('')).toBe('hi');
});

test('a negative or zero-length entity is ignored', () => {
  expect(toStyledSpans({ text: 'hi', entities: [{ kind: EntityKinds.BOLD, offset: 0, length: 0 }] }))
    .toEqual([{ text: 'hi', kinds: [], url: null }]);
});

test('spans always reconstruct the original text exactly', () => {
  const text = 'Chào 🔥 bạn, xem https://example.com nhé';
  const spans = toStyledSpans({
    text, entities: [
      { kind: EntityKinds.BOLD, offset: 0, length: 4 },
      { kind: EntityKinds.URL, offset: 17, length: 19 },
    ],
  });
  expect(spans.map(span => span.text).join('')).toBe(text);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test __tests__/tui/entities.test.ts`
Expected: FAIL — `Cannot find module '../../src/tui/entities.ts'`

- [ ] **Step 3: Write `src/tui/entities.ts`**

```ts
import { EntityKinds, type ITelegramEntity, type TEntityKind } from '../core/common/index.ts';
import { toGraphemes } from './text-width.ts';

export interface IStyledSpan {
  text: string;
  kinds: TEntityKind[];
  url: string | null;
}

/**
 * Telegram entity offsets are UTF-16 code units; tglow renders graphemes. This
 * builds one boundary table up front and never indexes the raw string by an
 * entity offset, which would split an emoji or a combining sequence.
 */
const buildGraphemeBoundaries = (opts: { text: string }): { grapheme: string; startUnit: number }[] => {
  const boundaries: { grapheme: string; startUnit: number }[] = [];
  let unit = 0;

  for (const { grapheme } of toGraphemes({ text: opts.text })) {
    boundaries.push({ grapheme, startUnit: unit });
    unit += grapheme.length; // .length is UTF-16 code units, which is what Telegram counts
  }

  return boundaries;
};

export const toStyledSpans = (opts: { text: string; entities: ITelegramEntity[] }): IStyledSpan[] => {
  const { text, entities } = opts;

  if (text === '') {
    return [{ text: '', kinds: [], url: null }];
  }

  const boundaries = buildGraphemeBoundaries({ text });
  const usable = entities.filter(entity => entity.length > 0 && entity.offset >= 0);

  const spans: IStyledSpan[] = [];
  let current: IStyledSpan | null = null;

  for (const { grapheme, startUnit } of boundaries) {
    const covering = usable.filter(entity => {
      return startUnit >= entity.offset && startUnit < entity.offset + entity.length;
    });

    const kinds = covering
      .map(entity => entity.kind)
      .filter(kind => kind !== EntityKinds.UNKNOWN);
    const url = covering.find(entity => entity.url !== undefined)?.url ?? null;
    const signature = `${[...kinds].sort().join(',')}|${url ?? ''}`;

    if (current && `${[...current.kinds].sort().join(',')}|${current.url ?? ''}` === signature) {
      current.text += grapheme;
      continue;
    }

    current = { text: grapheme, kinds, url };
    spans.push(current);
  }

  return spans;
};
```

- [ ] **Step 4: Run and watch them pass**

Run: `bun test __tests__/tui/entities.test.ts`
Expected: PASS — 11 tests

If the emoji tests fail, the cause is `grapheme.length` versus code points — `.length` on a JavaScript string is UTF-16 code units, which is exactly what Telegram counts, so it is correct here. Do not change it to `[...grapheme].length`.

- [ ] **Step 5: Commit**

```bash
git add src/tui/entities.ts __tests__/tui/entities.test.ts
git commit -m "Convert Telegram entities into styled spans

Offsets arrive as UTF-16 code units while the renderer works in
graphemes. Indexing the raw string by an offset splits an emoji or a
combining sequence, which shows up first on Vietnamese text rather than
on ASCII, so the conversion goes through one boundary table built up
front. Overlapping entities flatten into spans carrying every kind that
covers them, and an unknown kind degrades to plain text."
```

---

### Task 3: Span-aware wrapping

**Files:**
- Create: `src/tui/wrap-spans.ts`
- Test: `__tests__/tui/wrap-spans.test.ts`

**Interfaces:**
- Consumes: `IStyledSpan`; `measureTextWidth`, `toGraphemes` from `text-width.ts`
- Produces: `wrapSpans(opts: { spans: IStyledSpan[]; width: number }): IStyledSpan[][]` — one array per rendered row

- [ ] **Step 1: Write the failing test**

`__tests__/tui/wrap-spans.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { EntityKinds } from '../../src/core/common/index.ts';
import { wrapSpans } from '../../src/tui/wrap-spans.ts';

const plain = (text: string) => ({ text, kinds: [], url: null });

test('spans that fit stay on one row', () => {
  expect(wrapSpans({ spans: [plain('hello')], width: 10 })).toEqual([[plain('hello')]]);
});

test('wrapping breaks on spaces', () => {
  const rows = wrapSpans({ spans: [plain('one two three')], width: 7 });
  expect(rows.map(row => row.map(span => span.text).join(''))).toEqual(['one two', 'three']);
});

// The point of the module: a style must not be lost at a row boundary.
test('a style spanning a wrap survives on both rows', () => {
  const rows = wrapSpans({
    spans: [{ text: 'aaa bbb', kinds: [EntityKinds.BOLD], url: null }],
    width: 4,
  });
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row[0]!.kinds).toEqual([EntityKinds.BOLD]);
  }
  expect(rows.map(row => row.map(span => span.text).join(''))).toEqual(['aaa', 'bbb']);
});

test('a row can carry several spans with different styles', () => {
  const rows = wrapSpans({
    spans: [plain('see '), { text: 'here', kinds: [EntityKinds.TEXT_URL], url: 'https://example.com' }],
    width: 20,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.map(span => span.text)).toEqual(['see ', 'here']);
  expect(rows[0]![1]!.url).toBe('https://example.com');
});

test('a word longer than the width is hard-split rather than overflowing', () => {
  const rows = wrapSpans({ spans: [plain('abcdefghij')], width: 4 });
  for (const row of rows) {
    expect(row.map(span => span.text).join('').length).toBeLessThanOrEqual(4);
  }
  expect(rows.map(row => row.map(span => span.text).join('')).join('')).toBe('abcdefghij');
});

test('wide characters count as two columns', () => {
  const rows = wrapSpans({ spans: [plain('日本語です')], width: 4 });
  expect(rows.length).toBeGreaterThan(1);
});

test('width of zero or less returns a single row rather than looping', () => {
  expect(wrapSpans({ spans: [plain('hi')], width: 0 })).toEqual([[plain('hi')]]);
});

test('empty spans still produce one row so the message occupies a line', () => {
  expect(wrapSpans({ spans: [plain('')], width: 10 })).toEqual([[plain('')]]);
});

test('the concatenated rows reconstruct the original text', () => {
  const text = 'Chào bạn, đây là một tin nhắn dài để kiểm tra xuống dòng';
  const rows = wrapSpans({ spans: [plain(text)], width: 12 });
  expect(rows.map(row => row.map(span => span.text).join('')).join(' ')).toBe(text);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test __tests__/tui/wrap-spans.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/tui/wrap-spans.ts`**

Flatten the spans into styled graphemes, wrap by display width, then re-group
adjacent graphemes that share a style back into spans. Reuse `wrapText`'s
break rules rather than re-deriving them: break on spaces, hard-split a word
longer than the width.

```ts
import { measureTextWidth, toGraphemes } from './text-width.ts';
import type { IStyledSpan } from './entities.ts';

interface IStyledGrapheme {
  grapheme: string;
  width: number;
  kinds: IStyledSpan['kinds'];
  url: string | null;
}

const flatten = (opts: { spans: IStyledSpan[] }): IStyledGrapheme[] => {
  return opts.spans.flatMap(span =>
    toGraphemes({ text: span.text }).map(({ grapheme, width }) => ({
      grapheme, width, kinds: span.kinds, url: span.url,
    })),
  );
};

const regroup = (opts: { graphemes: IStyledGrapheme[] }): IStyledSpan[] => {
  const spans: IStyledSpan[] = [];
  let current: IStyledSpan | null = null;

  for (const item of opts.graphemes) {
    const signature = `${[...item.kinds].sort().join(',')}|${item.url ?? ''}`;
    const currentSignature = current
      ? `${[...current.kinds].sort().join(',')}|${current.url ?? ''}`
      : null;

    if (current && signature === currentSignature) {
      current.text += item.grapheme;
      continue;
    }

    current = { text: item.grapheme, kinds: item.kinds, url: item.url };
    spans.push(current);
  }

  return spans.length === 0 ? [{ text: '', kinds: [], url: null }] : spans;
};

export const wrapSpans = (opts: { spans: IStyledSpan[]; width: number }): IStyledSpan[][] => {
  const { spans, width } = opts;

  if (width <= 0) {
    return [spans.length === 0 ? [{ text: '', kinds: [], url: null }] : spans];
  }

  const graphemes = flatten({ spans });
  if (graphemes.length === 0) {
    return [[{ text: '', kinds: [], url: null }]];
  }

  const rows: IStyledGrapheme[][] = [];
  let row: IStyledGrapheme[] = [];
  let used = 0;
  let lastBreak = -1;

  for (const item of graphemes) {
    if (used + item.width > width && row.length > 0) {
      if (lastBreak >= 0) {
        const carry = row.slice(lastBreak + 1);
        rows.push(row.slice(0, lastBreak));
        row = carry;
        used = carry.reduce((total, entry) => total + entry.width, 0);
      } else {
        rows.push(row);
        row = [];
        used = 0;
      }
      lastBreak = -1;
    }

    row.push(item);
    used += item.width;
    if (item.grapheme === ' ') {
      lastBreak = row.length - 1;
    }
  }

  if (row.length > 0) {
    rows.push(row);
  }

  return rows.map(entries => regroup({ graphemes: entries }));
};
```

- [ ] **Step 4: Run and watch them pass**

Run: `bun test __tests__/tui/wrap-spans.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/tui/wrap-spans.ts __tests__/tui/wrap-spans.test.ts
git commit -m "Wrap styled spans without losing a style at a row boundary

wrapText handles a plain string. A bold run crossing a wrap has to stay
bold on both rows, so wrapping now works over styled graphemes and
regroups them afterwards."
```

---

### Task 4: Render spans in the message view

**Files:**
- Modify: `src/tui/panes/message-view.tsx`
- Test: `__tests__/tui/panes/message-view.test.tsx`

**Interfaces:**
- Consumes: `toStyledSpans`, `wrapSpans`, `IMessageRow.entities`
- Produces: no new exports; `IMessageViewProps` unchanged

- [ ] **Step 1: Write the failing test**

Append to `__tests__/tui/panes/message-view.test.tsx`:

```ts
test('a link renders its text, and the URL is not printed inline', async () => {
  const messages = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: 'see here', entities: [{ kind: 'textUrl', offset: 4, length: 4, url: 'https://example.com' }],
  }];
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={0} focused tokens={tokens} height={6} width={50}
                 resolveSenderName={resolveSenderName} />,
    { width: 50, height: 6 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('see here');
  expect(frame).not.toContain('https://example.com');
});

test('a spoiler is hidden until revealed', async () => {
  const messages = [{
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
  const messages = [{
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

test('a long styled message wraps into the content column, not to column zero', async () => {
  const long = 'this is a deliberately long message that must wrap more than once inside the pane';
  const messages = [{
    peerId: 'u1', id: 1, fromId: 'u1', date: 100, out: 0, replyToMessageId: null,
    text: long, entities: [{ kind: 'bold', offset: 0, length: 4 }],
  }];
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={0} focused tokens={tokens} height={8} width={50}
                 resolveSenderName={resolveSenderName} />,
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
```

Add `revealedSpoilers: Set<number>` to `IMessageViewProps`, defaulting to an
empty set where the existing tests construct the component.

- [ ] **Step 2: Run and watch them fail**

Run: `bun test __tests__/tui/panes/message-view.test.tsx`
Expected: FAIL — spans are not rendered; the URL appears or the spoiler shows.

- [ ] **Step 3: Render spans**

Replace the plain-text path with: `toStyledSpans` on the message, mask spoiler
spans with `█` repeated to the span's display width unless the message id is in
`revealedSpoilers`, then `wrapSpans` to the content width, then one `<text>` per
row containing one `<span>` per styled span. Map kinds to attributes:

| Kinds include | Rendering |
| --- | --- |
| `bold` | OpenTUI `<b>` |
| `italic` | `<i>` |
| `underline` | `<u>` |
| `code`, `pre` | `fg={tokens.textCode}` |
| `url`, `textUrl`, `mention`, `hashtag` | `fg={tokens.textLink}` with `<u>` |
| `spoiler` (unrevealed) | `fg={tokens.messageCursor}` on the same background |

Add `textCode` (palette `GREEN`) and `textLink` (palette `SKY`) to `ITokens` and
`buildTokens` — the M1 spec §6 names both and neither exists yet.

- [ ] **Step 4: Run the whole suite**

```bash
bun test
bun run typecheck
```

Expected: green, warnings 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Render message entities instead of plain text

Links, bold, code and spoilers now render as themselves. Spoilers are
masked until revealed, and wrapped rows stay in the content column."
```

---

### Task 5: Reveal a spoiler with `zs`

**Files:**
- Modify: `src/keys/common/constants.ts` (`ActionTypes`), `src/keys/common/types.ts` (`TAction`), `src/keys/keymap.ts`, `src/core/application-store.ts`, `src/tui/action-reducer.ts`, `src/tui/app.tsx`
- Test: `__tests__/keys/keymap.test.ts`, `__tests__/tui/action-reducer.test.ts`, `__tests__/tui/app.test.tsx`

**Interfaces:**
- Consumes: `revealedSpoilers` prop from Task 4
- Produces: `ActionTypes.SPOILER_REVEAL`; `IApplicationState.revealedSpoilers: Set<number>`

- [ ] **Step 1: Write the failing tests**

In `__tests__/keys/keymap.test.ts`:

```ts
test('zs reveals the spoiler on the message under the cursor', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('z'), keymap });
  expect(pending.status).toBe('pending');
  expect(engine.resolve({ state: pending.state, key: buildKey('s'), keymap }).actions)
    .toEqual([{ type: ActionTypes.SPOILER_REVEAL }]);
});
```

In `__tests__/tui/action-reducer.test.ts`:

```ts
test('spoiler.reveal adds the message under the cursor', () => {
  const state = buildState({ messageCursor: 1 });
  const patch = applyAction({ state, action: { type: ActionTypes.SPOILER_REVEAL } });
  expect([...patch.revealedSpoilers!]).toEqual([state.messages[1]!.id]);
});

test('revealing twice keeps one entry and does not throw', () => {
  const state = buildState({ messageCursor: 0, revealedSpoilers: new Set([1]) });
  const patch = applyAction({ state, action: { type: ActionTypes.SPOILER_REVEAL } });
  expect([...patch.revealedSpoilers!]).toEqual([1]);
});

test('revealing with no messages is harmless', () => {
  const state = buildState({ messages: [], messageCursor: 0 });
  expect(() => applyAction({ state, action: { type: ActionTypes.SPOILER_REVEAL } })).not.toThrow();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test __tests__/keys/keymap.test.ts __tests__/tui/action-reducer.test.ts`
Expected: FAIL — `SPOILER_REVEAL` does not exist.

- [ ] **Step 3: Implement**

Add `SPOILER_REVEAL = 'spoiler.reveal'` to `ActionTypes` and the variant
`{ type: typeof ActionTypes.SPOILER_REVEAL }` to `TAction`. Add
`revealedSpoilers: Set<number>` to `IApplicationState`, initialised empty.

Bind in `keymap.ts`, normal mode, any context:

```ts
    {
      context: '*', mode: VimModes.NORMAL, keys: 'zs', description: 'Reveal spoiler',
      action: () => [{ type: ActionTypes.SPOILER_REVEAL }],
    },
```

In `applyAction`, return a **new** Set containing the id of
`state.messages[state.messageCursor]`, or `{}` when there is no message —
never mutate the existing set, or `useSyncExternalStore` will not re-render.

Pass `revealedSpoilers` from `app.tsx` into `MessageView`.

- [ ] **Step 4: Run everything**

```bash
bun test
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Reveal a spoiler with zs

Mirrors vim's z prefix. Reveals are per message, held in the store and
not persisted, so reopening a chat hides them again."
```

---

### Task 6: Reply

**Files:**
- Modify: `src/core/message-service.ts`, `src/core/telegram-adapter.ts`, `src/keys/keymap.ts`, `src/keys/common/constants.ts`, `src/keys/common/types.ts`, `src/core/application-store.ts`, `src/tui/action-reducer.ts`, `src/tui/panes/composer.tsx`, `src/tui/panes/message-view.tsx`, `src/tui/app.tsx`
- Test: `__tests__/core/message-service.test.ts`, `__tests__/tui/app.test.tsx`

**Interfaces:**
- Consumes: `IRawMessage.replyToMessageId` from Task 1
- Produces: `IMessageAdapter.send` gains `replyToMessageId?: number`; `IApplicationState.replyToMessageId: number | null`; `ActionTypes.REPLY_START`, `ActionTypes.REPLY_CANCEL`

- [ ] **Step 1: Write the failing service test**

```ts
test('sending with a reply target passes it to the adapter', async () => {
  const sent: Array<{ text: string; replyToMessageId?: number }> = [];
  const harness = buildService(buildAdapter({
    send: async opts => { sent.push(opts); return buildRawMessage({ text: opts.text }); },
  }));
  await harness.service.send({ peerId: 'u1', text: 'sure', replyToMessageId: 7 });
  expect(sent[0]!.replyToMessageId).toBe(7);
  harness.database.close();
});

test('a successful reply clears the reply target', async () => {
  const harness = buildService(buildAdapter());
  harness.store.setState({ patch: { activePeerId: 'u1', composerText: 'sure', replyToMessageId: 7 } });
  await harness.service.send({ peerId: 'u1', text: 'sure', replyToMessageId: 7 });
  expect(harness.store.getState().replyToMessageId).toBeNull();
  harness.database.close();
});

test('a failed reply keeps both the text and the reply target', async () => {
  const harness = buildService(buildAdapter({ send: async () => { throw new Error('FLOOD_WAIT_30'); } }));
  harness.store.setState({ patch: { composerText: 'sure', replyToMessageId: 7 } });
  await harness.service.send({ peerId: 'u1', text: 'sure', replyToMessageId: 7 });
  expect(harness.store.getState().composerText).toBe('sure');
  expect(harness.store.getState().replyToMessageId).toBe(7);
  harness.database.close();
});
```

- [ ] **Step 2: Write the failing interface test**

In `__tests__/tui/app.test.tsx`:

```ts
test('r starts a reply and the composer shows the quoted message', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('r'); });
  await renderer.flush();
  expect(store.getState().replyToMessageId).toBe(store.getState().messages[store.getState().messageCursor]!.id);
  expect(renderer.captureCharFrame()).toContain('Replying');
});

test('escape cancels a reply without leaving normal mode', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('r'); });
  await renderer.flush();
  await pressEscape(renderer);
  expect(store.getState().replyToMessageId).toBeNull();
  expect(store.getState().engine.mode).toBe('normal');
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `bun test __tests__/core/message-service.test.ts __tests__/tui/app.test.tsx`
Expected: FAIL — `replyToMessageId` does not exist.

- [ ] **Step 4: Implement**

- `IMessageAdapter.send(opts: { peerId; text; replyToMessageId?: number })`; the
  adapter passes `replyTo` to GramJS's `sendMessage`. Read the option name from
  `node_modules/telegram/client/messages.d.ts` rather than guessing.
- `MessageService.send` takes and forwards `replyToMessageId`, clears it in the
  success patch alongside `composerText`, and leaves it untouched on failure —
  the same rule that already protects the composer.
- `ActionTypes.REPLY_START` sets `replyToMessageId` from the cursor;
  `REPLY_CANCEL` clears it. Bind `r` in normal mode. `<escape>` in normal mode
  cancels a reply when one is pending, and is otherwise unbound.
- The composer renders one dimmed row above the prompt when replying:
  `Replying to <sender>: <first line, truncated>`.
- The message view renders a dimmed quote row above any message whose
  `replyToMessageId` matches a message it already holds; when it does not, show
  `Replying to an earlier message` rather than nothing.

- [ ] **Step 5: Run everything, then commit**

```bash
bun test && bun run typecheck
git add -A
git commit -m "Reply to a message

r targets the message under the cursor, the composer shows what is being
answered, and escape cancels. A failed send keeps both the text and the
target, so nothing typed is lost."
```

---

### Task 7: Edit your own message

**Files:**
- Modify: `src/core/message-service.ts`, `src/core/telegram-adapter.ts`, `src/keys/keymap.ts`, `src/core/application-store.ts`, `src/tui/action-reducer.ts`, `src/tui/panes/composer.tsx`, `src/tui/app.tsx`
- Test: `__tests__/core/message-service.test.ts`, `__tests__/tui/app.test.tsx`

**Interfaces:**
- Produces: `IMessageAdapter.edit(opts: { peerId; messageId; text }): Promise<IRawMessage>`; `MessageService.edit(...)`; `IApplicationState.editingMessageId: number | null`; `ActionTypes.EDIT_START`, `ActionTypes.EDIT_CANCEL`

- [ ] **Step 1: Write the failing tests**

```ts
test('editing sends the new text for the right message id', async () => {
  const edits: Array<{ messageId: number; text: string }> = [];
  const harness = buildService(buildAdapter({
    edit: async opts => { edits.push(opts); return buildRawMessage({ id: opts.messageId, text: opts.text }); },
  }));
  await harness.service.edit({ peerId: 'u1', messageId: 5, text: 'fixed' });
  expect(edits).toEqual([{ peerId: 'u1', messageId: 5, text: 'fixed' }]);
  harness.database.close();
});

test('a successful edit updates the cached message rather than adding one', async () => {
  const harness = buildService(buildAdapter({
    edit: async opts => buildRawMessage({ id: opts.messageId, text: opts.text }),
  }));
  harness.database.insertMessages({ messages: [{ peerId: 'u1', id: 5, fromId: 'me', date: 100, text: 'typo', out: 1, entities: [], replyToMessageId: null }] });
  await harness.service.edit({ peerId: 'u1', messageId: 5, text: 'fixed' });
  const rows = harness.database.listMessages({ peerId: 'u1', limit: 10 });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toBe('fixed');
  harness.database.close();
});

test('a failed edit keeps the text in the composer', async () => {
  const harness = buildService(buildAdapter({ edit: async () => { throw new Error('MESSAGE_NOT_MODIFIED'); } }));
  harness.store.setState({ patch: { composerText: 'fixed', editingMessageId: 5 } });
  await harness.service.edit({ peerId: 'u1', messageId: 5, text: 'fixed' });
  expect(harness.store.getState().composerText).toBe('fixed');
  expect(harness.store.getState().editingMessageId).toBe(5);
  harness.database.close();
});
```

In `app.test.tsx`: `e` on an own message loads its text into the composer and
enters insert mode; `e` on someone else's message does nothing and sets a status
message; `<escape>` cancels editing and restores the composer to what it held.

- [ ] **Step 2: Run and watch them fail**, then implement.

`edit` mirrors `send`: adapter call in its own try, cache write in another, the
composer cleared only on success and only if unchanged. `EDIT_START` refuses when
`out !== 1` — you cannot edit someone else's message and the interface should say
so rather than failing at the server.

- [ ] **Step 3: Run everything, then commit**

```bash
bun test && bun run typecheck
git add -A
git commit -m "Edit your own message

e loads the message under the cursor into the composer and sending
replaces it rather than posting again. Editing someone else's message is
refused in the interface rather than at the server."
```

---

### Task 8: Delete, with confirmation

**Files:**
- Modify: `src/core/message-service.ts`, `src/core/telegram-adapter.ts`, `src/keys/keymap.ts`, `src/core/application-store.ts`, `src/tui/action-reducer.ts`, `src/tui/panes/status-line.tsx`, `src/tui/app.tsx`
- Test: `__tests__/core/message-service.test.ts`, `__tests__/tui/app.test.tsx`

**Interfaces:**
- Produces: `IMessageAdapter.delete(opts: { peerId; messageId; forEveryone: boolean }): Promise<void>`; `MessageService.delete(...)`; `IApplicationState.pendingConfirmation: { kind: 'delete'; messageId: number } | null`; `ActionTypes.DELETE_REQUEST`, `ActionTypes.CONFIRM`, `ActionTypes.CANCEL_CONFIRMATION`

- [ ] **Step 1: Write the failing tests**

The behaviour that matters: **`dd` alone must not delete anything.**

```ts
test('dd asks for confirmation and does not delete yet', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  expect(deleted).toEqual([]);
  expect(store.getState().pendingConfirmation).not.toBeNull();
  expect(renderer.captureCharFrame()).toContain('Delete');
});

test('y confirms and deletes', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('y'); });
  await renderer.flush();
  expect(deleted).toHaveLength(1);
  expect(store.getState().pendingConfirmation).toBeNull();
});

test('n cancels and deletes nothing', async () => {
  const { renderer, store, deleted } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('n'); });
  await renderer.flush();
  expect(deleted).toEqual([]);
  expect(store.getState().pendingConfirmation).toBeNull();
});

test('while a confirmation is pending, j does not move the cursor', async () => {
  const { renderer, store } = await mount();
  const before = store.getState().messageCursor;
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(before);
});
```

- [ ] **Step 2: Run and watch them fail**, then implement.

Bind `dd` — **not bare `d`**, which the engine cannot yet disambiguate; that
lands in M1b-2. While `pendingConfirmation` is set, `App` routes `y` and `n` to
confirm and cancel and swallows every other key, so a stray `j` cannot move the
cursor under a pending delete.

`MessageService.delete` deletes for everyone when the message is the user's own
and the chat allows it, otherwise for self, and sets a status message saying
which happened. Mark the row `deleted = 1` in the cache rather than removing it,
so history paging does not develop a hole.

- [ ] **Step 3: Run everything, then commit**

```bash
bun test && bun run typecheck
git add -A
git commit -m "Delete a message, behind a confirmation

dd asks on the status line and deletes only on y. A mistyped dd is not
undoable, so it cannot be a single keystroke. Every other key is
swallowed while the confirmation is pending."
```

---

### Task 9: Mark as read, and read receipts

**Files:**
- Modify: `src/core/message-service.ts`, `src/core/telegram-adapter.ts`, `src/core/dialog-service.ts`, `src/tui/panes/message-view.tsx`, `src/tui/app.tsx`
- Test: `__tests__/core/message-service.test.ts`, `__tests__/tui/panes/message-view.test.tsx`

**Interfaces:**
- Produces: `IMessageAdapter.markRead(opts: { peerId; maxId: number }): Promise<void>`; `MessageService.markRead(...)`; `IMessageRow` gains nothing — the tick uses the dialog's `readOutboxMaxId`

- [ ] **Step 1: Write the failing tests**

```ts
test('opening a chat marks its newest message read', async () => {
  const read: Array<{ peerId: string; maxId: number }> = [];
  const harness = buildService(buildAdapter({ markRead: async opts => { read.push(opts); } }));
  await harness.service.loadHistory({ peerId: 'u1', limit: 50 });
  await harness.service.markRead({ peerId: 'u1', maxId: 9 });
  expect(read).toEqual([{ peerId: 'u1', maxId: 9 }]);
  harness.database.close();
});

// Reading is an explicit act. Auto-reading what the user has not seen is how a
// client loses trust.
test('a chat merely present in the list is never marked read', async () => {
  const read: unknown[] = [];
  const harness = buildService(buildAdapter({ markRead: async opts => { read.push(opts); } }));
  await harness.service.loadHistory({ peerId: 'u1', limit: 50 });
  expect(read).toEqual([]);
  harness.database.close();
});

test('marking read twice within the debounce window calls the adapter once', async () => {
  const read: unknown[] = [];
  const harness = buildService(buildAdapter({ markRead: async opts => { read.push(opts); } }));
  await harness.service.markRead({ peerId: 'u1', maxId: 9 });
  await harness.service.markRead({ peerId: 'u1', maxId: 9 });
  expect(read).toHaveLength(1);
  harness.database.close();
});

test('a failed markRead is logged and does not reject', async () => {
  const harness = buildService(buildAdapter({ markRead: async () => { throw new Error('offline'); } }));
  await expect(harness.service.markRead({ peerId: 'u1', maxId: 9 })).resolves.toBeUndefined();
  harness.database.close();
});
```

For the view: an own message at or below `readOutboxMaxId` renders `✓✓`; above
it, `✓`; a message that is not the user's own renders neither.

- [ ] **Step 2: Run and watch them fail**, then implement.

Debounce per peer with a two-second window held on the service. `markRead` never
rethrows — it is a courtesy call and must not take down a read path.

`App` calls `markRead` when a chat is opened and when the cursor reaches the
newest message, never on chat-list movement.

- [ ] **Step 3: Run everything, then commit**

```bash
bun test && bun run typecheck
git add -A
git commit -m "Mark chats read, and show read receipts

Opening a chat and reaching its newest message marks it read, debounced
per peer. Scrolling the chat list does not -- reading is an explicit
act. Own messages show one tick when sent and two once read."
```

---

### Task 10: `pts` state and gap recovery

The feature the release notes admit is missing: messages sent while tglow was
closed are never backfilled.

**Files:**
- Create: `src/core/difference-service.ts`
- Modify: `src/core/telegram-adapter.ts`, `src/common/binding-keys.ts`, `src/container.ts`
- Test: `__tests__/core/difference-service.test.ts`

**Interfaces:**
- Consumes: `DatabaseService.getSyncState` / `setSyncState` (exist, unused); `IRawMessage`
- Produces: `IDifferenceAdapter { getState(): Promise<IUpdateState>; getDifference(opts: { state: IUpdateState }): Promise<IDifferenceResult> }`, `DifferenceService.catchUp(): Promise<void>`

```ts
export interface IUpdateState { pts: number; qts: number; date: number; seq: number; }
export interface IDifferenceResult {
  messages: IRawMessage[];
  state: IUpdateState;
  isTooLong: boolean;
}
```

- [ ] **Step 1: Write the failing test**

`__tests__/core/difference-service.test.ts`:

```ts
test('a first run with no stored state stores the server state and fetches nothing', async () => {
  const harness = build({ getState: async () => ({ pts: 100, qts: 0, date: 5, seq: 1 }) });
  await harness.service.catchUp();
  expect(harness.database.getSyncState({ key: 'pts' })).toBe(100);
  expect(harness.fetched).toEqual([]);
  harness.database.close();
});

test('a later run fetches the difference from the stored pts and applies the messages', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, text: 'missed you' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 },
      isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await harness.service.catchUp();
  expect(harness.applied.map(message => message.text)).toEqual(['missed you']);
  expect(harness.database.getSyncState({ key: 'pts' })).toBe(120);
  harness.database.close();
});

test('backfilled messages go through the same path as live ones', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 2, peerId: 'u1', text: 'missed' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await harness.service.catchUp();
  expect(harness.database.listMessages({ peerId: 'u1', limit: 10 }).map(row => row.text)).toContain('missed');
  harness.database.close();
});

// Reconciling a too-long difference is where clients lose messages quietly.
test('differenceTooLong stores the new state and does not pretend to have caught up', async () => {
  const harness = build({
    getDifference: async () => ({ messages: [], state: { pts: 900, qts: 0, date: 9, seq: 2 }, isTooLong: true }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await harness.service.catchUp();
  expect(harness.database.getSyncState({ key: 'pts' })).toBe(900);
  expect(harness.store.getState().statusMessage).toContain('history');
  harness.database.close();
});

test('a failing adapter is logged and leaves the stored state untouched', async () => {
  const harness = build({ getDifference: async () => { throw new Error('offline'); } });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await expect(harness.service.catchUp()).resolves.toBeUndefined();
  expect(harness.database.getSyncState({ key: 'pts' })).toBe(100);
  harness.database.close();
});

test('catchUp applies messages in id order', async () => {
  const harness = build({
    getDifference: async () => ({
      messages: [buildRawMessage({ id: 3, text: 'third' }), buildRawMessage({ id: 2, text: 'second' })],
      state: { pts: 120, qts: 0, date: 9, seq: 2 }, isTooLong: false,
    }),
  });
  harness.database.setSyncState({ key: 'pts', value: 100 });
  await harness.service.catchUp();
  expect(harness.applied.map(message => message.id)).toEqual([2, 3]);
  harness.database.close();
});
```

- [ ] **Step 2: Run and watch them fail**, then write `difference-service.ts`.

The adapter wraps `updates.getState` and `updates.getDifference`. Read the real
shapes from `node_modules/telegram/tl/api.d.ts` — `updates.difference`,
`updates.differenceSlice`, `updates.differenceEmpty` and `differenceTooLong` are
distinct result classes and the code must handle all four. Say in your report
which you relied on.

`catchUp` never rethrows: it logs and leaves stored state alone, because a
failed catch-up must degrade to "no backfill", never to a crash or to a
corrupted `pts` that skips messages permanently.

- [ ] **Step 3: Run everything, then commit**

```bash
bun test && bun run typecheck
git add -A
git commit -m "Recover the update difference so closed-client messages arrive

Messages sent while tglow was closed were never backfilled. pts, qts,
date and seq now persist in sync_state -- a table present since M1a and
never used -- and catch-up applies what the server reports through the
same path live updates take, so a backfilled message and a live one are
indistinguishable."
```

---

### Task 11: Wire catch-up, and verify scope coverage

**Files:**
- Modify: `src/main.ts`, `README.md`
- Test: `__tests__/keys/keymap.test.ts` (extend the promised-keys guard)

- [ ] **Step 1: Wire it**

Resolve `DifferenceService` and call `catchUp()` after `syncDialogs` and before
the first `loadHistory`, so a chat opens already containing what was missed. It
must not block startup on failure — it already swallows.

- [ ] **Step 2: Extend the promised-keys guard**

M1a's guard asserts every documented key is bound. Add `r`, `e`, `dd`, `zs`,
`y`, `n`. This test exists because three features were written in a spec and
silently dropped, and a test that only checks what exists cannot catch that.

- [ ] **Step 3: Update the README key table**

Add `r`, `e`, `dd`, `zs`. Remove the release-notes line saying messages missed
while closed are not backfilled — it is no longer true, and an untrue README is
worse than a missing one.

- [ ] **Step 4: Verify scope coverage against the spec**

For each row of the spec's §2 table marked M1b-1, name the task that implements
it and confirm a test asserts it:

| Feature | Task | Test |
| --- | --- | --- |
| rich text entities | 1–4 | `entities.test.ts`, `wrap-spans.test.ts`, `message-view.test.tsx` |
| spoilers | 4–5 | `message-view.test.tsx`, `action-reducer.test.ts` |
| reply | 6 | `message-service.test.ts`, `app.test.tsx` |
| edit | 7 | `message-service.test.ts`, `app.test.tsx` |
| delete | 8 | `message-service.test.ts`, `app.test.tsx` |
| mark as read + receipts | 9 | `message-service.test.ts`, `message-view.test.tsx` |
| `pts` gap recovery | 10 | `difference-service.test.ts` |

Any row without both is not done.

- [ ] **Step 5: Full verification and commit**

```bash
bun test
bun run typecheck
bun test 2>&1 | grep -ciE 'MaxListeners|not wrapped in act'
bun run build && ls -lh dist/
```

All green, warning count 0, and the binary still builds.

```bash
git add -A
git commit -m "Wire catch-up at startup and close out M1b-1

Extends the promised-keys guard to the new bindings and corrects the
README, which still claimed messages missed while closed are not
backfilled."
```

---

## Self-Review

**Spec coverage.** Every §3 requirement maps to a task: entities §3.1 → Tasks
1–4; spoiler reveal §3.1 → Task 5; reply/edit/delete §3.2 → Tasks 6–8;
mark-as-read and receipts §3.3 → Task 9; `pts` gap recovery §3.4 → Task 10;
wiring → Task 11. §4 (M1b-2) is deliberately out of scope for this plan and is
specced, not planned.

**Placeholder scan.** No TBD or TODO. Every code step carries runnable code.
Three steps say "read the real shapes from `node_modules/...`" rather than
quoting an API — that is deliberate: GramJS's `sendMessage` reply option,
its entity class names, and the four `updates.difference*` result classes were
all wrong-guessable, and one guessed field name silently disables a feature.
M1a lost a whole feature to exactly that with `getPeerId`'s `addMark`.

**Type consistency.** `ITelegramEntity` is defined once in Task 1 and used in
Tasks 2–4. `IStyledSpan` is defined in Task 2 and consumed in Tasks 3–4.
`IRawMessage`'s two new fields are added in Task 1 and relied on in Tasks 6–10.
`ActionTypes` gains `SPOILER_REVEAL` (5), `REPLY_START`/`REPLY_CANCEL` (6),
`EDIT_START`/`EDIT_CANCEL` (7), `DELETE_REQUEST`/`CONFIRM`/`CANCEL_CONFIRMATION`
(8) — each added in its own task and handled in `applyAction`'s switch, whose
`default` throws.

**Two risks worth naming.**

1. **Task 1 widens `IRawMessage` and `IMessageRow`**, so every construction site
   in the existing tests breaks at once. That is intentional — making the fields
   optional would let a caller silently drop entities, which is the bug being
   fixed. Expect the first task to touch many test files.
2. **Task 8 binds `dd` but not `d`.** The engine still cannot disambiguate a
   binding that is also a prefix, and the invariant test pinning that limitation
   stays green until M1b-2 replaces it. Binding bare `d` before then would make
   `dd` unreachable.
