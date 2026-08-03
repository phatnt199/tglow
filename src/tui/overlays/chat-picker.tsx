import type { IDialogRow } from '../../core/cache/index.ts';
import type { ITokens } from '../theme/index.ts';
import { measureTextWidth, padToWidth, truncateToWidth } from '../text-width.ts';
import { resolveVisibleRange } from '../viewport.ts';

export interface IChatPickerProps {
  /** Already fuzzy-matched and sorted best-first by App (fuzzy-match.ts) -- this component only lays the results out. */
  results: IDialogRow[];
  query: string;
  cursor: number;
  tokens: ITokens;
  /** Columns available; App sizes the panes above this using resolveChatPickerHeight, so the two must stay in lockstep. */
  width: number;
}

const RULE = '─';
const PROMPT = 'Jump to chat: ';
const CURSOR_GLYPH = '█';
const NO_RESULTS_LABEL = 'No chats match';
/** The rule and the query prompt: present no matter how many results there are. */
const FIXED_ROWS = 2;
/**
 * Bounds the popup's growth the same way WhichKey's own MAXIMUM_COLUMNS
 * bounds its width -- unlike the keymap's ~30 bindings, a chat list can be
 * far longer than any terminal is tall, so unlike WhichKey this component
 * scrolls (resolveVisibleRange) rather than ever growing past this.
 */
export const MAXIMUM_VISIBLE_RESULTS = 8;

/**
 * Total rows ChatPicker renders for this many results. App needs this
 * *before* it can size the panes above the overlay -- see
 * resolveWhichKeyHeight's own comment for why -- so this is exported and both
 * sides call it, rather than App guessing a number and this component
 * rendering a different one. At least one result row always, even at zero
 * results: that is where "No chats match" goes.
 */
export const resolveChatPickerHeight = (opts: { resultCount: number }): number => {
  return FIXED_ROWS + Math.min(MAXIMUM_VISIBLE_RESULTS, Math.max(1, opts.resultCount));
};

/**
 * The `<C-p>` popup: replaces the composer and grows upward, exactly like
 * WhichKey, and for the same reason -- it must never float over the message
 * view, which this renderer has no way to clip. Fuzzy matching itself
 * (fuzzy-match.ts) and the query/cursor state both live in App; this
 * component only lays out whatever it is handed.
 */
export const ChatPicker = (props: IChatPickerProps) => {
  const { results, query, cursor, tokens, width } = props;

  const { start, end } = resolveVisibleRange({
    total: results.length,
    cursor,
    height: MAXIMUM_VISIBLE_RESULTS,
  });

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
      {results.length === 0 ? (
        <text height={1} flexShrink={0} fg={tokens.dim}>{padToWidth({ text: NO_RESULTS_LABEL, width })}</text>
      ) : (
        results.slice(start, end).map((dialog, offset) => {
          const index = start + offset;
          const highlighted = index === cursor;
          return (
            <text key={dialog.peerId} height={1} flexShrink={0} bg={highlighted ? tokens.messageCursor : undefined}>
              <span fg={tokens.foreground}>
                {padToWidth({ text: truncateToWidth({ text: dialog.title, width }), width })}
              </span>
            </text>
          );
        })
      )}
    </box>
  );
};
