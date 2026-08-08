import { completions } from '../command-line.ts';
import { measureTextWidth, truncateToWidth } from '../text-width.ts';
import type { ITokens } from '../theme/index.ts';

export interface ICommandLineProps {
  query: string;
  tokens: ITokens;
  width: number;
}

/** One column of air at the left, matching the status line it stands in for. */
const EDGE_PADDING = 1;
/** The prompt, and the block cursor that follows what has been typed. */
const PROMPT = ':';
const CURSOR = '█';
/** Between the typed command and what it could still become. */
const HINT_GAP = 2;

/**
 * The command line, in the row the status line usually occupies.
 *
 * In place of it rather than above it, which is what vim does and what keeps
 * the chrome budget honest: the status line is exactly one row (app.tsx's
 * STATUS_LINE_HEIGHT), and a command line that added a second would resize
 * every pane on screen the moment `:` was pressed -- for the duration of one
 * word.
 *
 * The right-hand hint is what a half-typed word could still become, and the
 * description once it can only become one thing. Neither is a suggestion the
 * user has to act on: `<Tab>` fills it in, and typing on ignores it.
 */
export const CommandLine = (props: ICommandLineProps) => {
  const { query, tokens, width } = props;

  const typed = `${PROMPT}${query}${CURSOR}`;
  const candidates = completions({ input: query });
  // One candidate has a meaning worth stating; several have only names worth
  // listing. Nothing matches at all -- a mistyped word -- says nothing here
  // and waits for Enter to say it properly.
  const hint = candidates.length === 1
    ? candidates[0]!.description
    : candidates.map(candidate => candidate.spellings[0]).join(' ');

  const spent = EDGE_PADDING + measureTextWidth({ text: typed }) + HINT_GAP + EDGE_PADDING;
  const shown = truncateToWidth({ text: hint, width: Math.max(0, width - spent) });
  const filler = Math.max(HINT_GAP, width - spent - measureTextWidth({ text: shown }) + HINT_GAP);

  return (
    <box flexDirection="row" width={width} height={1}>
      <text height={1} flexShrink={0}>
        <span fg={tokens.dim}>{' '.repeat(EDGE_PADDING)}</span>
        <span fg={tokens.foreground}>{typed}</span>
        <span fg={tokens.dim}>{`${' '.repeat(filler)}${shown}${' '.repeat(EDGE_PADDING)}`}</span>
      </text>
    </box>
  );
};
