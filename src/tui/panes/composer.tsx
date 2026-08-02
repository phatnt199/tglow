import { VimModes, type TVimMode } from '../../keys/common/index.ts';
import type { ITokens } from '../theme/index.ts';

export interface IComposerProps {
  text: string;
  mode: TVimMode;
  focused: boolean;
  tokens: ITokens;
}

export const Composer = (props: IComposerProps) => {
  const { text, mode, focused, tokens } = props;

  const showHint = text === '' && mode !== VimModes.INSERT;
  const cursor = mode === VimModes.INSERT && focused ? '█' : '';

  return (
    <box flexDirection="row" border borderColor={tokens.border}>
      <text fg={tokens.modeInsert}>{'❯ '}</text>
      {showHint ? (
        <text fg={tokens.dim}>press i to write…</text>
      ) : (
        <text fg={tokens.foreground}>
          {text}
          {cursor}
        </text>
      )}
    </box>
  );
};
