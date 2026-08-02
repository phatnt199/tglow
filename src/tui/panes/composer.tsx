import { VimModes, type TVimMode } from '../../keys/common/index.ts';
import type { ITokens } from '../theme/index.ts';
import { extractTailToWidth, measureTextWidth, padToWidth } from '../text-width.ts';

export interface IComposerProps {
  text: string;
  mode: TVimMode;
  focused: boolean;
  tokens: ITokens;
  /** Columns available; the rule spans all of them and the prompt clips to them. */
  width: number;
}

const PROMPT = '❯ ';
const CURSOR = '█';
const HINT = 'press i to write…';
const RULE = '─';

/**
 * A rule and a prompt: two rows, always. Letting the prompt wrap would take a
 * row from the panes above without telling them, and a column given more rows
 * of children than it has shrinks them until they overdraw each other.
 */
export const Composer = (props: IComposerProps) => {
  const { text, mode, focused, tokens, width } = props;

  const showHint = text === '' && mode !== VimModes.INSERT;
  const cursor = mode === VimModes.INSERT && focused ? CURSOR : '';
  const room = Math.max(
    0,
    width - measureTextWidth({ text: PROMPT }) - measureTextWidth({ text: cursor }),
  );
  // The tail rather than the head: the caret is at the end, so that is the part
  // being typed and the part worth showing.
  const body = padToWidth({ text: `${extractTailToWidth({ text, width: room })}${cursor}`, width: room });

  return (
    <box flexDirection="column" width={width}>
      <text height={1} flexShrink={0} fg={tokens.border}>{RULE.repeat(Math.max(0, width))}</text>
      <text height={1} flexShrink={0}>
        <span fg={tokens.modeInsert}>{PROMPT}</span>
        {showHint ? <span fg={tokens.dim}>{HINT}</span> : <span fg={tokens.foreground}>{body}</span>}
      </text>
    </box>
  );
};
