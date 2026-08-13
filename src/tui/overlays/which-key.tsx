import { getError } from '@venizia/ignis-inversion';
import { NO_CONTINUATION_MESSAGE } from '../../keys/which-key-menu.ts';

import { VimContexts, type TVimContext, type TVimMode } from '../../keys/common/index.ts';
import type { ITokens } from '../theme/index.ts';
import { padToWidth, truncateToWidth } from '../text-width.ts';

export interface IWhichKeyProps {
  bindings: Array<{ keys: string; description: string }>;
  /** What has already been typed, when the popup was opened by a pending prefix. */
  prefix?: string;
  mode: TVimMode;
  context: TVimContext;
  tokens: ITokens;
  /** Columns available; App sizes the panes above this using resolveWhichKeyHeight, so the two must stay in lockstep. */
  width: number;
}

const KEY_COLUMN_WIDTH = 10;
const DESCRIPTION_COLUMN_WIDTH = 20;
const COLUMN_GAP = 2;
const ENTRY_WIDTH = KEY_COLUMN_WIDTH + DESCRIPTION_COLUMN_WIDTH + COLUMN_GAP;
const MAXIMUM_COLUMNS = 3;
const RULE = '─';

/** The rule and the heading: present no matter how many bindings there are. */
const FIXED_ROWS = 2;

const resolveColumnCount = (opts: { width: number }): number => {
  return Math.max(1, Math.min(MAXIMUM_COLUMNS, Math.floor(opts.width / ENTRY_WIDTH)));
};

/**
 * Total rows WhichKey renders for this many bindings at this width. App needs
 * this *before* it can size the panes above the overlay -- OpenTUI has no way
 * to measure a subtree and then lay out around it -- so this is exported and
 * both sides call it, rather than App guessing a number and this component
 * rendering a different one.
 */
export const resolveWhichKeyHeight = (opts: { bindingCount: number; width: number }): number => {
  const columns = resolveColumnCount({ width: opts.width });
  return FIXED_ROWS + Math.ceil(opts.bindingCount / columns);
};

const resolvePaneLabel = (opts: { context: TVimContext }): string => {
  switch (opts.context) {
    case VimContexts.CHAT_LIST: {
      return 'chat list';
    }
    case VimContexts.MESSAGES: {
      return 'messages';
    }
    case VimContexts.COMPOSER: {
      return 'composer';
    }
    default: {
      throw getError({ message: `[which-key][resolvePaneLabel] Unknown context | Context: ${opts.context}` });
    }
  }
};

/**
 * The \\ popup. Renders in place of the composer and grows upward -- it must
 * never float over the message view, which this renderer has no way to clip.
 * `KeymapService.describe` is already mode- and context-aware, so `bindings`
 * arrives pre-filtered for exactly the state the user is in; this component
 * only lays it out.
 */
export const WhichKey = (props: IWhichKeyProps) => {
  const { bindings, mode, context, tokens, width, prefix = '' } = props;

  const columns = resolveColumnCount({ width });
  const rows = Math.ceil(bindings.length / columns);
  // With a prefix pending, the prefix *is* the heading: what this is showing
  // is what completes it, and repeating the mode and pane there would push the
  // one piece of information the popup was opened for off to the side.
  const heading = prefix === ''
    ? `Keys · ${mode.toUpperCase()} · ${resolvePaneLabel({ context })}`
    : `${prefix} · ${bindings.length === 0 ? NO_CONTINUATION_MESSAGE : 'what follows'}`;

  return (
    <box flexDirection="column" width={width}>
      <text height={1} flexShrink={0} fg={tokens.border}>{RULE.repeat(Math.max(0, width))}</text>
      <text height={1} flexShrink={0} fg={tokens.foreground}>{heading}</text>
      {Array.from({ length: rows }, (unused, row) => {
        // Column-major, like the which-key plugin this echoes: the first
        // column fills top to bottom before the second one starts, so
        // bindings declared next to each other in the table stay next to
        // each other on screen instead of scattering across a row.
        const entries = Array.from({ length: columns }, (alsoUnused, column) => bindings[column * rows + row]);

        return (
          <text key={row} height={1} flexShrink={0}>
            {entries.flatMap((binding, column) => {
              if (!binding) {
                return [];
              }
              return [
                <span key={`${column}-keys`} fg={tokens.chatUnread}>
                  {padToWidth({ text: binding.keys, width: KEY_COLUMN_WIDTH })}
                </span>,
                <span key={`${column}-description`} fg={tokens.dim}>
                  {padToWidth({
                    text: truncateToWidth({ text: binding.description, width: DESCRIPTION_COLUMN_WIDTH }),
                    width: DESCRIPTION_COLUMN_WIDTH + COLUMN_GAP,
                  })}
                </span>,
              ];
            })}
          </text>
        );
      })}
    </box>
  );
};
