/**
 * What `R` offers, and which key sends each one.
 *
 * Home-row keys rather than a cursor to move: reacting is a two-keystroke
 * thing in every client that does it well, and `R` then `a` is two. A row of
 * choices you have to walk to with h/l would be four or five for the ones on
 * the right, which is how a quick gesture becomes a chore.
 *
 * The set is Telegram's own most-used, in its own order. tglow does not fetch
 * the account's available reactions: a chat can restrict which are allowed,
 * and the server rejects a disallowed one with a message this shows -- which
 * is a better failure than a picker that quietly omits what you wanted.
 */
export interface IReactionChoice {
  key: string;
  emoji: string;
}

export const REACTION_CHOICES: readonly IReactionChoice[] = [
  { key: 'a', emoji: '👍' },
  { key: 's', emoji: '❤️' },
  { key: 'd', emoji: '🔥' },
  { key: 'f', emoji: '🎉' },
  { key: 'g', emoji: '😂' },
  { key: 'h', emoji: '😮' },
  { key: 'j', emoji: '😢' },
  { key: 'k', emoji: '🙏' },
  { key: 'l', emoji: '👎' },
];

/** The emoji a key stands for, or null when the key is not one of them. */
export const resolveReactionKey = (opts: { key: string }): string | null =>
  REACTION_CHOICES.find(choice => choice.key === opts.key)?.emoji ?? null;
