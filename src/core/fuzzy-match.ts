/**
 * Subsequence fuzzy matching over a list of candidate strings -- pure, no UI,
 * no notion of what a "chat" is. `src/tui/overlays/chat-picker.tsx` is the
 * one caller; kept separate so the scoring algorithm is testable against
 * plain strings, with no renderer in the loop.
 *
 * The owner's own chat list is mostly Vietnamese (`Đức anh hoàng`, `Em Việt
 * Tú`, `Nga Trần`), so matching folds away case and diacritics on both sides
 * before comparing: `duc` finds `Đức anh hoàng`, and so does `Đức` typed with
 * its own diacritics still on. See toFoldedText below for how `Đ`/`đ` --
 * letters in their own right, not `D`/`d` plus an accent -- are handled,
 * since `String.prototype.normalize('NFD')` alone does not touch them.
 */

/**
 * `Đ`/`đ` are their own Latin Extended-A code points (U+0110/U+0111), not a
 * base letter composed with a combining mark, so NFD decomposition leaves
 * them untouched -- verified empirically. Folded by hand, ahead of NFD, so
 * every other Vietnamese diacritic (a precomposed base-plus-mark character --
 * "ệ", "ư", "ồ" and the rest) can go through the ordinary decompose-then-strip
 * pass below unchanged.
 */
const D_LETTER_FOLDS: Readonly<Record<string, string>> = { 'Đ': 'D', 'đ': 'd' };

/** Unicode's own "nonspacing mark" category -- every combining accent NFD peels off, not just the block Vietnamese happens to use. */
const COMBINING_MARK_PATTERN = /\p{Mn}/gu;

/**
 * Case- and diacritic-folded form of `text`, used only to decide what
 * matches what -- callers still render the original string; fuzzyMatch never
 * hands one back. `Array.from` iterates by code point (not UTF-16 code
 * unit), so the D_LETTER_FOLDS lookup -- and a surrogate-pair emoji elsewhere
 * in the text -- both see one whole character at a time.
 */
const toFoldedText = (opts: { text: string }): string => {
  const { text } = opts;
  const withBaseD = Array.from(text).map(character => D_LETTER_FOLDS[character] ?? character).join('');
  return withBaseD.normalize('NFD').replace(COMBINING_MARK_PATTERN, '').toLowerCase();
};

/** Anything that is not a letter or a digit -- a space, a dash, an em dash -- separates one word from the next. */
const NON_WORD_PATTERN = /[^\p{L}\p{N}]/u;

/** True at the very start of `folded`, or wherever the character just before `position` is a separator. */
const isWordBoundary = (opts: { folded: string; position: number }): boolean => {
  const { folded, position } = opts;
  return position === 0 || NON_WORD_PATTERN.test(folded[position - 1]!);
};

const MATCH_SCORE = 1;
/** The brief's "a contiguous run scores above a scattered one". */
const CONSECUTIVE_RUN_BONUS = 15;
/** The brief's "a match at a word boundary scores above one mid-word". */
const WORD_BOUNDARY_BONUS = 10;

const UNREACHABLE = Number.NEGATIVE_INFINITY;

/**
 * The best score for aligning `query` as a subsequence of `folded`, or null if
 * it is not a subsequence at all. Dynamic programming over (candidate
 * position, query position), because a greedy leftmost match can miss a
 * better-scoring alignment -- "a_ab" against "ab" greedily matches a@0 then
 * has to reach past the second "a" for its "b", when a@2/b@3 is both
 * contiguous and available.
 *
 * `currentRow[matched]` holds the best score for aligning `query[0..matched)`
 * ending with `query[matched - 1]` placed *exactly* at the character just
 * consumed -- fixing that position, rather than only tracking the best score
 * for the prefix, is what lets `consecutive` below tell a contiguous run
 * apart from a scattered one. `prefixBest[matched]` is the running best of
 * that same column over every earlier position: the score available to an
 * alignment that accepts a gap there instead.
 */
const resolveSubsequenceScore = (opts: { folded: string; query: string }): number | null => {
  const { folded, query } = opts;
  if (query.length === 0 || query.length > folded.length) {
    return null;
  }

  let previousRow = new Array<number>(query.length + 1).fill(UNREACHABLE);
  const prefixBest = new Array<number>(query.length + 1).fill(UNREACHABLE);

  for (let position = 1; position <= folded.length; position += 1) {
    const currentRow = new Array<number>(query.length + 1).fill(UNREACHABLE);
    const character = folded[position - 1]!;
    const characterScore = MATCH_SCORE + (isWordBoundary({ folded, position: position - 1 }) ? WORD_BOUNDARY_BONUS : 0);

    for (let matched = 1; matched <= Math.min(position, query.length); matched += 1) {
      if (character !== query[matched - 1]) {
        continue;
      }

      if (matched === 1) {
        currentRow[matched] = characterScore;
        continue;
      }

      const consecutive = previousRow[matched - 1] === UNREACHABLE
        ? UNREACHABLE
        : previousRow[matched - 1]! + CONSECUTIVE_RUN_BONUS;
      const gapped = prefixBest[matched - 1]!;
      const bestPredecessor = Math.max(consecutive, gapped);
      currentRow[matched] = bestPredecessor === UNREACHABLE ? UNREACHABLE : characterScore + bestPredecessor;
    }

    for (let matched = 0; matched <= query.length; matched += 1) {
      prefixBest[matched] = Math.max(prefixBest[matched]!, currentRow[matched]!);
    }
    previousRow = currentRow;
  }

  const best = prefixBest[query.length]!;
  return best === UNREACHABLE ? null : best;
};

export const fuzzyMatch = (opts: { candidates: string[]; query: string }): { index: number; score: number }[] => {
  const { candidates, query } = opts;
  const foldedQuery = toFoldedText({ text: query });

  if (foldedQuery === '') {
    return candidates.map((unused, index) => ({ index, score: 0 }));
  }

  const matches: { index: number; score: number }[] = [];
  candidates.forEach((candidate, index) => {
    const score = resolveSubsequenceScore({ folded: toFoldedText({ text: candidate }), query: foldedQuery });
    if (score !== null) {
      matches.push({ index, score });
    }
  });

  // Best match first; Array.prototype.sort is stable (ES2019+), so two
  // candidates that tie keep the relative order they arrived in.
  return matches.sort((a, b) => b.score - a.score);
};
