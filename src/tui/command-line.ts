/**
 * `:` — the command line.
 *
 * Everything here is also a key, or is something a key should never be: `:q`
 * is `<C-c>`, `:pin` is `P`, and `:logout` has no key at all because a
 * single keystroke should not be able to end a session. That is the rule this
 * file follows, the mirror of the context menu's own -- a command is another
 * way to reach an action, never a second implementation of one, and never a
 * way around a confirmation.
 *
 * Parsing is pure and lives apart from App: what a typed string means is worth
 * testing without a terminal attached.
 */
export class CommandNames {
  static readonly QUIT = 'quit';
  static readonly HELP = 'help';
  static readonly READ = 'read';
  static readonly PIN = 'pin';
  static readonly UNPIN = 'unpin';
  static readonly RELOAD = 'reload';
  static readonly GOTO = 'goto';
  static readonly LOGOUT = 'logout';
}

export type TCommandName = (typeof CommandNames)[Exclude<keyof typeof CommandNames, 'prototype'>];

export interface ICommandSpec {
  name: TCommandName;
  /** What the user types. The first is the canonical spelling, shown in completions and help. */
  spellings: readonly string[];
  description: string;
  /**
   * True when running it asks y/n first. Only for what cannot be undone by
   * typing the same command again -- the same bar `dd` clears and `P` does
   * not.
   */
  confirms?: boolean;
}

export const COMMANDS: readonly ICommandSpec[] = [
  { name: CommandNames.QUIT, spellings: ['quit', 'q', 'q!', 'qa'], description: 'Close tglow' },
  { name: CommandNames.HELP, spellings: ['help', 'h'], description: 'Show the key bindings' },
  { name: CommandNames.READ, spellings: ['read'], description: 'Mark the open chat read' },
  { name: CommandNames.PIN, spellings: ['pin'], description: 'Pin the message under the cursor' },
  { name: CommandNames.UNPIN, spellings: ['unpin'], description: 'Unpin the message under the cursor' },
  { name: CommandNames.RELOAD, spellings: ['reload', 'e'], description: 'Reload the open chat from Telegram' },
  {
    name: CommandNames.LOGOUT,
    spellings: ['logout'],
    description: 'Sign out on Telegram, erase the local session and cache, and quit',
    confirms: true,
  },
];

export interface IParsedCommand {
  /** The command, or null when nothing matches what was typed. */
  spec: ICommandSpec | null;
  /** Everything after the first word, trimmed. Empty when there was none. */
  argument: string;
  /**
   * The 1-based message a bare `:42` asks for, or null. vim's own `:{number}`,
   * and the reason parse returns this rather than a GOTO spec: a number is not
   * a word, so it cannot be completed, listed, or misspelled.
   */
  lineNumber: number | null;
}

const DIGITS = /^[0-9]+$/;

/**
 * What a typed line means.
 *
 * The leading `:` is not part of the input -- the overlay owns that character
 * and the user cannot delete it, exactly as vim's command line behaves.
 */
export const parseCommand = (opts: { input: string }): IParsedCommand => {
  const trimmed = opts.input.trim();
  const [word = '', ...rest] = trimmed.split(/\s+/);
  const argument = rest.join(' ');

  if (DIGITS.test(word)) {
    return { spec: null, argument, lineNumber: Number(word) };
  }

  const spec = COMMANDS.find(command => command.spellings.includes(word)) ?? null;
  return { spec, argument, lineNumber: null };
};

/**
 * The commands a half-typed word could still become, canonical spelling only.
 *
 * Aliases are deliberately not offered: completing `q` to `q!` would be
 * actively unhelpful, and a list that shows every spelling of the same command
 * teaches nothing about what commands exist.
 */
export const completions = (opts: { input: string }): ICommandSpec[] => {
  const word = opts.input.trim().split(/\s+/)[0] ?? '';
  // A line with a space in it has already chosen its command; completing the
  // word again would replace an argument the user is mid-way through typing.
  if (opts.input.includes(' ')) {
    return [];
  }
  return COMMANDS.filter(command => command.spellings[0]!.startsWith(word));
};

/**
 * What `<Tab>` fills in: the longest prefix every candidate shares, so a
 * single match completes fully and an ambiguous one advances as far as it can
 * without guessing. Returns the input unchanged when nothing matches.
 */
export const completeCommand = (opts: { input: string }): string => {
  const candidates = completions({ input: opts.input });
  const first = candidates[0];
  if (!first) {
    return opts.input;
  }

  let prefix = first.spellings[0]!;
  for (const candidate of candidates.slice(1)) {
    const other = candidate.spellings[0]!;
    let shared = 0;
    while (shared < prefix.length && shared < other.length && prefix[shared] === other[shared]) {
      shared += 1;
    }
    prefix = prefix.slice(0, shared);
  }
  return prefix;
};

/** What the command line says when Enter lands on something it does not know. */
export const describeUnknown = (opts: { input: string }): string =>
  `Not a command: ${opts.input.trim()}`;
