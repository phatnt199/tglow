/** Telegram message entity kinds tglow renders. Unknown kinds arrive as 'unknown'. */
export class EntityKinds {
  static readonly BOLD = 'bold';
  static readonly ITALIC = 'italic';
  static readonly UNDERLINE = 'underline';
  static readonly STRIKE = 'strike';
  static readonly CODE = 'code';
  static readonly PRE = 'pre';
  static readonly SPOILER = 'spoiler';
  static readonly URL = 'url';
  static readonly TEXT_URL = 'textUrl';
  static readonly MENTION = 'mention';
  static readonly HASHTAG = 'hashtag';
  static readonly UNKNOWN = 'unknown';
}

export type TEntityKind = (typeof EntityKinds)[Exclude<keyof typeof EntityKinds, 'prototype'>];

/**
 * `offset` and `length` are in UTF-16 code units, as Telegram sends them. They
 * are NOT grapheme or column indices — converting is `src/tui/entities.ts`'s job
 * and indexing the raw string with them directly will split emoji.
 */
export interface ITelegramEntity {
  kind: TEntityKind;
  offset: number;
  length: number;
  url?: string;
}
