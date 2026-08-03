const OSC52_PREFIX = '\x1b]52;c;';
const OSC52_TERMINATOR = '\x07';

/**
 * The OSC 52 clipboard-copy escape sequence for `text`: `ESC ] 52 ; c ; <base64> BEL`.
 * `c` addresses the system clipboard (as opposed to the primary selection or a
 * cut buffer); the payload is `text`'s UTF-8 bytes, base64-encoded -- not its
 * UTF-16 code units. Encoding code units instead would split every character
 * outside the Basic Multilingual Plane (an emoji) into a surrogate pair and
 * feed each half through independently, corrupting it, and would silently
 * mis-encode Vietnamese diacritics the same way -- the owner writes both, so
 * getting this wrong copies mojibake instead of the text actually on screen.
 * Empty text base64-encodes to an empty payload, a valid sequence a
 * conforming terminal reads as "clear the clipboard", not a special case.
 */
export const buildOsc52Sequence = (opts: { text: string }): string => {
  const base64 = Buffer.from(opts.text, 'utf-8').toString('base64');
  return `${OSC52_PREFIX}${base64}${OSC52_TERMINATOR}`;
};

/**
 * Builds the OSC 52 sequence for `text` and hands it to `write` exactly once.
 * Takes the writer as a parameter rather than reaching for `process.stdout`
 * itself: OpenTUI's renderer owns stdout and repaints the alternate screen
 * continuously, so a write from anywhere else can land mid-frame and
 * interleave with whatever the renderer is drawing at that instant -- the
 * exact mechanism behind this project's worst rendering bug (two messages'
 * characters interleaving on screen because a later draw's space did not
 * clear the earlier one's cell). Injecting `write` lets tests exercise this
 * with a plain in-memory function and lets a caller route production use
 * through whatever OpenTUI itself provides as a safe escape hatch, instead of
 * this module guessing at one.
 */
export const writeToClipboard = (opts: { text: string; write: (sequence: string) => void }): void => {
  opts.write(buildOsc52Sequence({ text: opts.text }));
};
