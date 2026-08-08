import { REACTION_CHOICES } from '../reaction-picker.ts';
import { measureTextWidth, truncateToWidth } from '../text-width.ts';
import type { ITokens } from '../theme/index.ts';

export interface IReactionPickerProps {
  tokens: ITokens;
  width: number;
  /** The reaction this account already has on the message, if any -- marked so pressing it again reads as taking it back. */
  chosen: string | null;
}

/** One column of air at each end, matching the status line it stands in for. */
const EDGE_PADDING = 1;
const PROMPT = 'React ';
/** Between one choice and the next. */
const CHOICE_GAP = '  ';

/**
 * The reaction picker, in the row the status line usually occupies.
 *
 * In place of it rather than above it, for the same reason the command line
 * is: the status line is exactly one row, and a picker that added a second
 * would resize every pane on screen for the duration of one keystroke.
 */
export const ReactionPicker = (props: IReactionPickerProps) => {
  const { tokens, width, chosen } = props;

  const shown = REACTION_CHOICES
    .map(choice => `${choice.key} ${choice.emoji}${choice.emoji === chosen ? '✓' : ''}`)
    .join(CHOICE_GAP);
  const room = Math.max(0, width - EDGE_PADDING * 2 - measureTextWidth({ text: PROMPT }));

  return (
    <box flexDirection="row" width={width} height={1}>
      <text height={1} flexShrink={0}>
        <span fg={tokens.dim}>{' '.repeat(EDGE_PADDING)}</span>
        <span fg={tokens.chatUnread}>{PROMPT}</span>
        <span fg={tokens.foreground}>{truncateToWidth({ text: shown, width: room })}</span>
      </text>
    </box>
  );
};
