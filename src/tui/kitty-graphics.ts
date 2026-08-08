/**
 * The Kitty graphics protocol: real pixels, in terminals that can take them.
 *
 * A picture drawn out of characters is a drawing of a photograph. Terminals
 * that implement this protocol -- kitty, Ghostty, WezTerm, Konsole, and foot
 * through its Sixel path -- accept the image itself and composite it over the
 * cells, so what appears is the photograph.
 *
 * Alacritty is not one of them and cannot be made into one: it has no Sixel
 * and no graphics protocol, which is a decision of that project rather than
 * something a client can work around. There, tglow keeps drawing with chafa.
 *
 * Everything here is a pure string builder. Deciding *whether* to use it, and
 * getting the bytes onto the terminal, are both somebody else's job -- which
 * is what makes the escape sequences testable without a terminal at all.
 */

/**
 * APC ... ST, which is how the protocol is framed.
 *
 * A terminal that does not understand it skips the whole sequence rather than
 * printing it, which is why sending this to the wrong terminal is untidy
 * rather than catastrophic -- but tglow asks first anyway, see supportsGraphics.
 */
const APC = '_G';
const ST = '\\';

/**
 * How much base64 goes in one chunk.
 *
 * The protocol's own limit is 4096 bytes of payload per escape sequence, and
 * an image is split across as many as it takes with `m=1` on every chunk but
 * the last. Exceeding it does not error -- it truncates, which shows up as
 * half a picture and no message about why.
 */
export const CHUNK_SIZE = 4096;

export interface IImagePlacement {
  /** The id this image was transmitted under, so it can be placed again without resending. */
  id: number;
  /** Where to put it, in cells, one-based like every cursor position. */
  row: number;
  column: number;
  /** How many cells it should cover. The terminal scales to fit. */
  columns: number;
  rows: number;
}

const toControl = (opts: { keys: Record<string, number | string> }): string =>
  Object.entries(opts.keys).map(([key, value]) => `${key}=${value}`).join(',');

/**
 * Send the image itself, once.
 *
 * `f=100` means "these bytes are a PNG or JPEG, work it out" -- the terminal
 * decodes it, so tglow does not have to hand over raw pixels it would first
 * have to produce. `q=2` silences the terminal's acknowledgement, which would
 * otherwise arrive on stdin and be read as keystrokes.
 *
 * `a=t` transmits without displaying: where it goes is a separate decision,
 * made per frame by `place` below, so a picture that scrolls does not need
 * sending again.
 */
export const transmit = (opts: { id: number; bytes: Uint8Array }): string => {
  const encoded = Buffer.from(opts.bytes).toString('base64');
  const chunks: string[] = [];

  for (let offset = 0; offset < encoded.length; offset += CHUNK_SIZE) {
    const payload = encoded.slice(offset, offset + CHUNK_SIZE);
    const last = offset + CHUNK_SIZE >= encoded.length;
    // Only the first chunk carries the full control data; the rest carry just
    // the continuation flag, which is what the protocol expects.
    const control = offset === 0
      ? toControl({ keys: { a: 't', f: 100, i: opts.id, q: 2, m: last ? 0 : 1 } })
      : toControl({ keys: { m: last ? 0 : 1 } });
    chunks.push(`${APC}${control};${payload}${ST}`);
  }

  return chunks.join('');
};

/**
 * Put an already-transmitted image somewhere, in cells.
 *
 * Re-sent every frame rather than placed once: the renderer redraws cells and
 * a picture is not made of cells, so the terminal has no reason to keep it
 * where it was. This is a few dozen bytes, unlike the image.
 *
 * `C=1` keeps the cursor where it was -- without it the terminal moves it past
 * the image and the next thing tglow draws lands in the wrong place.
 */
export const place = (opts: { placement: IImagePlacement }): string => {
  const { id, row, column, columns, rows } = opts.placement;
  const move = `[${row};${column}H`;
  const control = toControl({ keys: { a: 'p', i: id, c: columns, r: rows, q: 2, C: 1 } });
  return `${move}${APC}${control};${ST}`;
};

/** Forget an image the terminal is still holding. Transmitted images live until deleted, so a long session would otherwise accumulate every photo it had scrolled past. */
export const forget = (opts: { id: number }): string =>
  `${APC}${toControl({ keys: { a: 'd', d: 'I', i: opts.id, q: 2 } })};${ST}`;

/** Take every placement off the screen without forgetting the images, which is what a redraw of the conversation needs. */
export const clearPlacements = (): string =>
  `${APC}${toControl({ keys: { a: 'd', d: 'a', q: 2 } })};${ST}`;

/**
 * Whether this terminal will show a picture.
 *
 * Asked of the environment rather than by querying the terminal: the query is
 * an escape sequence whose reply arrives on stdin, and tglow's stdin belongs
 * to the key handler -- a reply landing there is a burst of keystrokes nobody
 * typed. The variables below are set by the terminals themselves.
 *
 * `TERM=xterm-kitty` is kitty's own. `KITTY_WINDOW_ID` is set by kitty and by
 * Ghostty. `TERM_PROGRAM` names WezTerm, Ghostty and others. Anything not
 * recognised is assumed unable, which costs a terminal that could have shown
 * a picture nothing but the drawing it would have got anyway.
 */
export const supportsGraphics = (opts: { environment: Record<string, string | undefined> }): boolean => {
  const { environment } = opts;
  if (environment.TGLOW_GRAPHICS === 'off') {
    return false;
  }
  // An explicit yes, for a terminal this does not know about yet.
  if (environment.TGLOW_GRAPHICS === 'on') {
    return true;
  }

  const term = environment.TERM ?? '';
  const program = (environment.TERM_PROGRAM ?? '').toLowerCase();
  return term === 'xterm-kitty'
    || term.startsWith('xterm-ghostty')
    || environment.KITTY_WINDOW_ID !== undefined
    || environment.GHOSTTY_RESOURCES_DIR !== undefined
    || ['wezterm', 'ghostty', 'kitty'].includes(program);
};
