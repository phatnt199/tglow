import { VimModes, type TVimMode } from '../../keys/common/index.ts';
import type { ITokens } from '../theme/index.ts';
import { extractTailToWidth, measureTextWidth, padToWidth, truncateToWidth } from '../text-width.ts';

/** The message being replied to, already resolved to a sender name by the caller -- this file only formats and fits it to `width`. */
export interface IReplyPreview {
  senderName: string;
  text: string;
}

export interface IComposerProps {
  text: string;
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
const CURSOR = '█';
const HINT = 'press i to write…';
const RULE = '─';
const EDITING_LABEL = 'Editing message';

const firstLineOf = (opts: { text: string }): string => opts.text.split(/\r\n|\r|\n/)[0] ?? '';

/**
 * A rule and a prompt: two rows always, growing by one more for each of a
 * pending reply and an in-progress edit (both can show at once -- r then e in
 * the same session -- though no single binding produces that combination).
 * Letting the prompt wrap would take a row from the panes above without
 * telling them, and a column given more rows of children than it has shrinks
 * them until they overdraw each other -- see message-view.tsx's own rail for
 * the same invariant. App accounts for each extra row the same way it
 * already does for the which-key overlay's variable height, so this growing
 * here must stay in lockstep with app.tsx's own chromeHeight calculation.
 */
export const Composer = (props: IComposerProps) => {
  const { text, mode, focused, tokens, width, replyingTo, editing } = props;

  const showHint = text === '' && mode !== VimModes.INSERT;
  const cursor = mode === VimModes.INSERT && focused ? CURSOR : '';
  const room = Math.max(
    0,
    width - measureTextWidth({ text: PROMPT }) - measureTextWidth({ text: cursor }),
  );
  // The tail rather than the head: the caret is at the end, so that is the part
  // being typed and the part worth showing.
  const body = padToWidth({ text: `${extractTailToWidth({ text, width: room })}${cursor}`, width: room });

  const editingRow = editing ? truncateToWidth({ text: EDITING_LABEL, width }) : null;
  const replyRow = replyingTo
    ? truncateToWidth({
        text: `Replying to ${replyingTo.senderName}: ${firstLineOf({ text: replyingTo.text })}`,
        width,
      })
    : null;

  return (
    <box flexDirection="column" width={width}>
      <text height={1} flexShrink={0} fg={tokens.border}>{RULE.repeat(Math.max(0, width))}</text>
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
        {showHint ? <span fg={tokens.dim}>{HINT}</span> : <span fg={tokens.foreground}>{body}</span>}
      </text>
    </box>
  );
};
