import { test, expect } from 'bun:test';

import { fuzzyMatch } from '../../core/fuzzy-match.ts';

const indexesOf = (opts: { candidates: string[]; query: string }): number[] =>
  fuzzyMatch(opts).map(match => match.index);

test('subsequence matching: dvs matches devs — backend', () => {
  expect(indexesOf({ candidates: ['devs — backend'], query: 'dvs' })).toEqual([0]);
});

// Every letter dsv names is present in "devs — backend", but not in that
// order: the only v sits before the only s, so this must fail exactly the
// way a missing letter would -- a subsequence matcher, not a bag-of-letters one.
test('a query is a subsequence, not just a set of present letters -- order matters', () => {
  expect(indexesOf({ candidates: ['devs — backend'], query: 'dsv' })).toEqual([]);
});

test('a query naming a letter the candidate does not have matches nothing', () => {
  expect(indexesOf({ candidates: ['devs — backend'], query: 'dvz' })).toEqual([]);
});

test('matching is case-insensitive', () => {
  expect(indexesOf({ candidates: ['DEVS — BACKEND'], query: 'dvs' })).toEqual([0]);
  expect(indexesOf({ candidates: ['devs — backend'], query: 'DVS' })).toEqual([0]);
});

test('a query longer than the candidate cannot match', () => {
  expect(indexesOf({ candidates: ['ab'], query: 'abcdef' })).toEqual([]);
});

test('an empty query returns every candidate, in original order', () => {
  const candidates = ['charlie', 'alpha', 'bravo'];
  expect(indexesOf({ candidates, query: '' })).toEqual([0, 1, 2]);
});

test('index refers to the position in the original candidates array, not the filtered list', () => {
  const candidates = ['no match here', 'devs — backend', 'also no match'];
  expect(indexesOf({ candidates, query: 'dvs' })).toEqual([1]);
});

// Isolated from word-boundary effects on purpose: "x" is a plain letter, not a
// separator, so the only thing distinguishing these two candidates is whether
// a/b/c sit next to each other. Only one alignment exists for either (each
// letter appears once), so there is no ambiguity in what is being compared.
test('a contiguous run scores above a scattered one, and sorts first', () => {
  const results = fuzzyMatch({ candidates: ['axbxcxxx', 'abcxxxxx'], query: 'abc' });
  expect(results.map(match => match.index)).toEqual([1, 0]);
  expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
});

// Isolated from contiguity effects on purpose: a single-character query has
// no notion of a "run", so the only thing distinguishing these two candidates
// is whether their one occurrence of "b" starts a word or sits inside one.
test('a match at a word boundary scores above one mid-word, and sorts first', () => {
  const results = fuzzyMatch({ candidates: ['xxbxx', 'xx bar'], query: 'b' });
  expect(results.map(match => match.index)).toEqual([1, 0]);
  expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
});

// --- Vietnamese -------------------------------------------------------------
//
// The single most important requirement (task-8-brief.md): the owner's own
// chat list is mostly Vietnamese. An ASCII-only matcher is useless to them --
// this is the difference between the feature working and being decoration.

test('nguyen finds Nguyễn Tấn Phát', () => {
  const candidates = ['Nguyễn Tấn Phát', 'Alice', 'Bob'];
  expect(indexesOf({ candidates, query: 'nguyen' })).toEqual([0]);
});

// Đ/đ are U+0110/U+0111, single letters of the Vietnamese alphabet rather than
// D carrying a mark, so NFD leaves them whole and only the explicit fold in
// toFoldedText reaches them. No name in the rest of this file contains one --
// without this case the fold is untested.
test('da finds Đà Nẵng -- Đ is its own letter, not D plus a diacritic', () => {
  const candidates = ['Đà Nẵng', 'Alice', 'Bob'];
  expect(indexesOf({ candidates, query: 'da' })).toEqual([0]);
});

test('viet finds Việt', () => {
  expect(indexesOf({ candidates: ['Em Việt Tú', 'Alice'], query: 'viet' })).toEqual([0]);
});

test('an exact diacritic query still matches', () => {
  expect(indexesOf({ candidates: ['Nguyễn Tấn Phát'], query: 'Nguyễn' })).toEqual([0]);
});

// Đà Nẵng rather than a personal name here on purpose: the matcher aligns the
// query as a subsequence, and `nga` is a subsequence of `Nguyễn Tấn Phát`
// (N-g-...-a), which would make this assert the opposite of what it reads as.
test('nga finds Nga Trần among a realistic Vietnamese chat list, and nothing else', () => {
  const candidates = ['Đà Nẵng', 'Em Việt Tú', 'Nga Trần'];
  expect(indexesOf({ candidates, query: 'nga' })).toEqual([2]);
});

test('a query with no Vietnamese match returns nothing, not every chat', () => {
  const candidates = ['Nguyễn Tấn Phát', 'Em Việt Tú', 'Nga Trần'];
  expect(indexesOf({ candidates, query: 'zzz' })).toEqual([]);
});
