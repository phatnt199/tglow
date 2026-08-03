import { VimModes, type TVimMode } from '../../keys/common/index.ts';
import type { ITokens } from '../theme/index.ts';
import { measureTextWidth, truncateToWidth } from '../text-width.ts';

export interface IStatusLineProps {
  mode: TVimMode;
  title: string;
  unreadCount: number;
  position: number;
  total: number;
  hint: string;
  tokens: ITokens;
  /** Columns available; position and hint are pushed to the far end of them. */
  width: number;
  /**
   * True while a destructive action (Task 8: delete) is waiting on y/n.
   * Recolours the title red rather than adding a row -- the status line stays
   * exactly one row either way (app.tsx's own STATUS_LINE_HEIGHT comment), so
   * the app's only irreversible action does not need its own chrome budget,
   * only a colour unmistakable enough that a skimmed status line still reads
   * as dangerous.
   */
  confirming: boolean;
  /**
   * True while `title` is carrying a data-integrity warning rather than a chat
   * name -- messages were, or may have been, lost. Colours it like
   * `confirming` for the same reason: a skimmed status line has to read as
   * wrong. Both are booleans on the same title rather than two rows, because
   * the status line stays exactly one row (app.tsx's STATUS_LINE_HEIGHT).
   */
  warning: boolean;
}

/** One column of air at each end, matching the pane rails above. */
const EDGE_PADDING = 1;
/** Between the mode block and the chat title. */
const CONTEXT_INDENT = 2;
/** Between the position and the hint, and the least air before the position. */
const SECTION_GAP = 3;

const resolveModeColour = (opts: { mode: TVimMode; tokens: ITokens; confirming: boolean }): string => {
  const { mode, tokens, confirming } = opts;

  // Waiting on y/n is its own mode: every other key is dropped until the
  // question is answered. lualine gives its blocking mode a block of its own
  // colour rather than leaving it reading NORMAL, so this does too.
  if (confirming) {
    return tokens.error;
  }

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

/** lualine's shape: mode block in section A, then context, then position. */
export const StatusLine = (props: IStatusLineProps) => {
  const { mode, title, unreadCount, position, total, hint, tokens, width, confirming, warning } = props;

  const block = ` ${mode.toUpperCase()} `;
  const context = unreadCount > 0 ? `${title} · ${unreadCount} unread` : title;
  const place = `${position}/${total}`;
  const trailing = `${hint === '' ? place : `${place}${' '.repeat(SECTION_GAP)}${hint}`}${' '.repeat(EDGE_PADDING)}`;

  const spent = measureTextWidth({ text: block }) + CONTEXT_INDENT + measureTextWidth({ text: trailing });
  // The title is the only elastic part: everything else is either the reader's
  // position or the way back to the keymap, and neither is worth losing to a
  // group name. Below zero the line has no room for a title at all.
  const room = Math.max(0, width - spent - SECTION_GAP);
  const shown = truncateToWidth({ text: context, width: room });
  const filler = Math.max(SECTION_GAP, width - spent - measureTextWidth({ text: shown }));

  return (
    <box flexDirection="row" width={width} height={1}>
      <text height={1} flexShrink={0} fg={tokens.background} bg={resolveModeColour({ mode, tokens, confirming })}>
        {block}
      </text>
      <text height={1} flexShrink={0}>
        <span fg={confirming || warning ? tokens.error : tokens.foreground}>
          {`${' '.repeat(CONTEXT_INDENT)}${shown}`}
        </span>
        <span fg={tokens.dim}>{`${' '.repeat(filler)}${trailing}`}</span>
      </text>
    </box>
  );
};
