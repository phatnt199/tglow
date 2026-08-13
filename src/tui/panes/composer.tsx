import { VimModes, type TVimMode } from '../../keys/common/index.ts';
import type { ITokens } from '../theme/index.ts';
import { resolveComposerWindow } from '../composer-window.ts';
import { measureTextWidth, padToWidth, truncateToWidth } from '../text-width.ts';

/** The message being replied to, already resolved to a sender name by the caller -- this file only formats and fits it to `width`. */
export interface IReplyPreview {
  senderName: string;
  text: string;
}

export interface IComposerProps {
  text: string;
  /**
   * The caret, in graphemes. Required rather than defaulted to the end of the
   * text: a call site that forgot it would silently go back to a composer you
   * can only append to, which is the bug this prop exists to close.
   */
  cursor: number;
  mode: TVimMode;
  focused: boolean;
  tokens: ITokens;
  /** Columns available; the rule spans all of them and the prompt clips to them. */
  width: number;
  /**
   * Null when no reply is pending. No default, like IMessageViewProps'
   * revealedSpoilers: a call site that forgot this prop would otherwise never
   * show a pending reply, silently.
   */
  replyingTo: IReplyPreview | null;
  /**
   * True while editingMessageId is set. Unlike replyingTo there is nothing
   * further to preview -- EDIT_START already copied the message's own text
   * into `text` -- so this is only the on-screen cue that Enter will replace
   * that message rather than post a new one. Required, not optional, for the
   * same reason replyingTo is: a call site that forgot it would silently
   * drop the only sign an edit is in progress.
   */
  editing: boolean;
}

const PROMPT = '❯ ';
/**
 * The prompt's width, exported so App can put the *terminal's* real cursor
 * exactly where the composer draws its own.
 *
 * That matters for input methods. A Vietnamese, Chinese or Japanese IME draws
 * its in-progress composition at the terminal cursor -- not through the
 * application at all -- so with the cursor hidden and parked wherever the last
 * write left it, the half-typed word appeared over the status line and only
 * jumped into the composer once it was committed.
 */
export const COMPOSER_PROMPT_WIDTH = measureTextWidth({ text: PROMPT });
const HINT = 'press i to write…';
const RULE = '─';
const EDITING_LABEL = 'Editing message';

const firstLineOf = (opts: { text: string }): string => opts.text.split(/\r\n|\r|\n/)[0] ?? '';

/**
 * A prompt: one row always, growing by one more for each of a pending reply
 * and an in-progress edit (both can show at once -- r then e in the same
 * session -- though no single binding produces that combination).
 *
 * The rule that used to sit above it is gone. M2's frame closes with its own
 * bottom edge directly above this, and two horizontal lines stacked read as a
 * mistake rather than a separation.
 * Letting the prompt wrap would take a row from the panes above without
 * telling them, and a column given more rows of children than it has shrinks
 * them until they overdraw each other -- see message-view.tsx's own rail for
 * the same invariant. App accounts for each extra row the same way it
 * already does for the which-key overlay's variable height, so this growing
 * here must stay in lockstep with app.tsx's own chromeHeight calculation.
 */
export const Composer = (props: IComposerProps) => {
  const { text, cursor, mode, focused, tokens, width, replyingTo, editing } = props;

  const showHint = text === '' && mode !== VimModes.INSERT;
  const room = Math.max(0, width - measureTextWidth({ text: PROMPT }));
  // Which slice of the draft is on screen, and where in it the caret stands.
  // Not the tail any more: the caret moves, so the visible part has to follow
  // it rather than always showing the end.
  const view = resolveComposerWindow({ text, cursor, room });
  // Drawn only while typing, like the block it replaces. In normal mode the
  // conversation's cursorline is what shows position, and a second caret
  // blinking in the composer would compete with it.
  const showCaret = mode === VimModes.INSERT && focused;
  // The caret is a reversed cell rather than a block glyph laid over the text,
  // so the letter underneath stays readable -- and past the end of the draft
  // it reverses a space, which draws the same solid block as before.
  const trailing = Math.max(
    0,
    room - view.caretColumn - measureTextWidth({ text: `${view.at}${view.after}` }),
  );

  const editingRow = editing ? truncateToWidth({ text: EDITING_LABEL, width }) : null;
  const replyRow = replyingTo
    ? truncateToWidth({
        text: `Replying to ${replyingTo.senderName}: ${firstLineOf({ text: replyingTo.text })}`,
        width,
      })
    : null;

  return (
    <box flexDirection="column" width={width}>
      {editingRow !== null ? (
        <text height={1} flexShrink={0}>
          <span fg={tokens.dim}>{padToWidth({ text: editingRow, width })}</span>
        </text>
      ) : null}
      {replyRow !== null ? (
        <text height={1} flexShrink={0}>
          <span fg={tokens.dim}>{padToWidth({ text: replyRow, width })}</span>
        </text>
      ) : null}
      <text height={1} flexShrink={0}>
        <span fg={tokens.modeInsert}>{PROMPT}</span>
        {showHint ? (
          <span fg={tokens.dim}>{padToWidth({ text: HINT, width: room })}</span>
        ) : (
          <>
            <span fg={tokens.foreground}>{view.before}</span>
            {showCaret ? (
              <span fg={tokens.background} bg={tokens.modeInsert}>{view.at}</span>
            ) : (
              <span fg={tokens.foreground}>{view.at}</span>
            )}
            <span fg={tokens.foreground}>{`${view.after}${' '.repeat(trailing)}`}</span>
          </>
        )}
      </text>
    </box>
  );
};
