import { test, expect } from 'bun:test';

import { EntityKinds, type TEntityKind } from '../../core/common/index.ts';
import { toStyledSpans } from '../../tui/entities.ts';

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
  // Array literal typed explicitly: EntityKinds.BOLD/.TEXT_URL are TEntityKind
  // literals, but an untyped array literal widens to string[], which
  // toEqual's inferred TEntityKind[] parameter (from spans[1]!.kinds) rejects.
  const expectedKinds: TEntityKind[] = [EntityKinds.BOLD, EntityKinds.TEXT_URL];
  expect(spans[1]!.kinds.sort()).toEqual(expectedKinds.sort());
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

// The test above only checks round-trip, which holds even if a combining
// mark ends up orphaned in its own span next to its base character -- the
// text would still concatenate back correctly. This one forces the decomposed
// case ('ệ' as three UTF-16 units: e + combining circumflex + combining dot
// below, all inside the BMP, so this is NOT the same disagreement the emoji
// tests cover) and points an entity at only the base letter's code unit, then
// asserts the bold span is the whole three-unit cluster -- proving a
// combining mark is never split from its base rather than merely proving no
// text went missing.
test('an entity pointing only at a decomposed base letter still bolds its combining marks', () => {
  const decomposedE = 'ệ'.normalize('NFD'); // 'e' + U+0302 + U+0323, 3 UTF-16 units, 1 grapheme
  const text = `a${decomposedE}b`;
  const entityLength = 1; // an entity as Telegram might send it, pointing at just the base 'e'
  const spans = toStyledSpans({ text, entities: [{ kind: EntityKinds.BOLD, offset: 1, length: entityLength }] });
  expect(spans.map(span => span.text).join('')).toBe(text);
  const bolded = spans.find(span => span.kinds.includes(EntityKinds.BOLD));
  expect(bolded?.text).toBe(decomposedE);
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

// Additional coverage beyond the brief, exercising branches the reference
// implementation needs but its own test list does not reach.

// wrap-text.ts guarantees one row for an empty message so gutter numbering
// never shifts; toStyledSpans makes the same promise for an empty message's
// span list, so a downstream renderer always has something to key a row on.
test('empty text produces a single empty span rather than none', () => {
  expect(toStyledSpans({ text: '', entities: [] })).toEqual([{ text: '', kinds: [], url: null }]);
});

// kinds is documented as a set: two entities of the same kind covering the
// same run must not double up in the output.
test('two entities of the same kind covering the same text produce one kind, not two', () => {
  const spans = toStyledSpans({
    text: 'ab', entities: [
      { kind: EntityKinds.BOLD, offset: 0, length: 2 },
      { kind: EntityKinds.BOLD, offset: 0, length: 2 },
    ],
  });
  expect(spans).toEqual([{ text: 'ab', kinds: [EntityKinds.BOLD], url: null }]);
});

// "Degrade to plain text" means no styling AND no link affordance -- a url
// sitting on an entity kind this build does not recognise must not survive
// into the span once its kind has been stripped.
test('a url on an unknown-kind entity is dropped along with the kind', () => {
  const spans = toStyledSpans({
    text: 'hello',
    entities: [{ kind: EntityKinds.UNKNOWN, offset: 0, length: 5, url: 'https://example.com' }],
  });
  expect(spans).toEqual([{ text: 'hello', kinds: [], url: null }]);
});
