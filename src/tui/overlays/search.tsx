import type { ITokens } from '../theme/index.ts';
import { measureTextWidth, padToWidth, truncateToWidth } from '../text-width.ts';

export interface ISearchOverlayProps {
  /** Typed live, one keystroke at a time -- App re-runs the search against the cache on every change (app.tsx), this component only lays out whatever query currently is. */
  query: string;
  tokens: ITokens;
  /** Columns available; App sizes the panes above this using SEARCH_OVERLAY_HEIGHT, so the two must stay in lockstep. */
  width: number;
}

const RULE = '─';
const PROMPT = 'Search: ';
const CURSOR_GLYPH = '█';

/**
 * Total rows SearchOverlay renders: the rule and the prompt, always exactly
 * these two -- unlike ChatPicker (which grows with its result count, up to a
 * cap) this has no results list of its own to draw. `Enter` jumps straight to
 * the first match and `n`/`N` (in the messages pane, once this overlay has
 * closed) step through the rest; there is nothing here to pick from. A plain
 * constant rather than a resolve*Height(opts) function, unlike its two
 * siblings, precisely because there is no input that could ever change it.
 */
export const SEARCH_OVERLAY_HEIGHT = 2;

/**
 * The `/` popup: replaces the composer and grows upward, exactly like
 * WhichKey and ChatPicker, and for the same reason -- it must never float
 * over the message view, which this renderer has no way to clip. The query
 * itself lives in IApplicationState (searchQuery); this component only lays
 * out whatever it is handed.
 */
export const SearchOverlay = (props: ISearchOverlayProps) => {
  const { query, tokens, width } = props;

  const promptWidth = Math.max(0, width - measureTextWidth({ text: CURSOR_GLYPH }));
  const promptText = padToWidth({
    text: truncateToWidth({ text: `${PROMPT}${query}`, width: promptWidth }),
    width: promptWidth,
  });

  return (
    <box flexDirection="column" width={width}>
      <text height={1} flexShrink={0} fg={tokens.border}>{RULE.repeat(Math.max(0, width))}</text>
      <text height={1} flexShrink={0}>
        <span fg={tokens.foreground}>{promptText}</span>
        <span fg={tokens.modeInsert}>{CURSOR_GLYPH}</span>
      </text>
    </box>
  );
};
