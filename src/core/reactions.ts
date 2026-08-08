/**
 * Who reacted to a message with what, as a tally.
 *
 * Telegram sends the whole set every time a reaction changes -- not a delta --
 * so a message's reactions are replaced wholesale rather than merged. That is
 * why they live in one JSON column beside the message rather than in a table
 * of their own: they are always read with their message, never queried across
 * messages, and never updated one row at a time.
 */
export interface IMessageReaction {
  /**
   * The emoji itself. A custom (Premium) reaction has no emoji this client can
   * draw -- it is a document id pointing at a sticker -- so it is stood in for
   * rather than dropped: the count is real, and showing nothing would make a
   * message with six custom reactions look like a message with none.
   */
  emoji: string;
  count: number;
  /** True when this account is one of the reactors. */
  chosen: boolean;
}

/** What a custom (Premium) reaction shows as, since its actual glyph is a sticker this client cannot draw. */
export const CUSTOM_REACTION_PLACEHOLDER = '✨';

/** Between one reaction and the next. Two spaces, not a dot: these are separate tallies, not one phrase. */
const REACTION_SEPARATOR = '  ';
/** Marks the ones this account chose, so your own reaction is findable at a glance. */
const CHOSEN_OPEN = '[';
const CHOSEN_CLOSE = ']';

/**
 * The tally line: `👍 3  ❤️ 1  [😂] 2`.
 *
 * Brackets rather than colour for the chosen one. Colour would say it too, but
 * only one of the two survives a terminal that is not showing colour, and this
 * is the one that also survives being copied out of the screen.
 *
 * A count of one is still shown. "👍" alone would be ambiguous with a reaction
 * that has no count at all, and the number is one column.
 */
export const describeReactions = (opts: { reactions: IMessageReaction[] }): string =>
  opts.reactions
    .filter(reaction => reaction.count > 0)
    .map(reaction => (reaction.chosen
      ? `${CHOSEN_OPEN}${reaction.emoji}${CHOSEN_CLOSE} ${reaction.count}`
      : `${reaction.emoji} ${reaction.count}`))
    .join(REACTION_SEPARATOR);
