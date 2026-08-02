import { VimModes, type TVimMode } from '../../keys/common/index.ts';
import type { ITokens } from '../theme/index.ts';

export interface IStatusLineProps {
  mode: TVimMode;
  title: string;
  unreadCount: number;
  position: number;
  total: number;
  hint: string;
  tokens: ITokens;
}

const resolveModeColour = (opts: { mode: TVimMode; tokens: ITokens }): string => {
  const { mode, tokens } = opts;

  switch (mode) {
    case VimModes.INSERT: {
      return tokens.modeInsert;
    }
    case VimModes.VISUAL: {
      return tokens.modeVisual;
    }
    default: {
      return tokens.modeNormal;
    }
  }
};

/** lualine-style: mode in section A, then context, then position. */
export const StatusLine = (props: IStatusLineProps) => {
  const { mode, title, unreadCount, position, total, hint, tokens } = props;

  const segments: string[] = [title];
  if (unreadCount > 0) {
    segments.push(`${unreadCount} unread`);
  }
  segments.push(`${position}/${total}`);
  if (hint !== '') {
    segments.push(hint);
  }

  return (
    <box flexDirection="row">
      <text fg={resolveModeColour({ mode, tokens })}>{` ${mode.toUpperCase()} `}</text>
      <text fg={tokens.dim}>{`│ ${segments.join(' │ ')}`}</text>
    </box>
  );
};
