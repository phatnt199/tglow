import type { IEngineState, TOperator } from '../keys/common/index.ts';
import { Operators } from '../keys/common/index.ts';
import type { TConnectionState } from '../core/application-store.ts';
import { measureTextWidth } from './text-width.ts';

/**
 * What the status line says, worked out before anything is drawn.
 *
 * The line is one row and always will be (app.tsx's STATUS_LINE_HEIGHT), so
 * every field competes for the same columns. Rather than let a narrow terminal
 * decide what survives by clipping whatever happens to be rightmost, each
 * segment carries a priority and the line drops the cheapest first. The
 * position and the mode are never dropped: they are the two things a vim user
 * reads without looking.
 */
export class StatusTones {
  /** The chat title and anything as load-bearing. */
  static readonly PLAIN = 'plain';
  /** Context: counts, ids, the clock. Most of the line. */
  static readonly DIM = 'dim';
  /** Something asking to be noticed -- unread, typing, a half-typed command. */
  static readonly ACCENT = 'accent';
  /** Something wrong: disconnected, over the message limit. */
  static readonly ALERT = 'alert';
}

export type TStatusTone = (typeof StatusTones)[Exclude<keyof typeof StatusTones, 'prototype'>];

export interface IStatusSegment {
  text: string;
  tone: TStatusTone;
  /** Higher survives longer as the terminal narrows. */
  priority: number;
}

/** Telegram's own cap on a single message. Past it the send is refused, so the count turns red before the user finds out the hard way. */
export const MESSAGE_LENGTH_LIMIT = 4096;

/**
 * Between two segments, and per group rather than one gap everywhere.
 *
 * The dot joins things that describe one subject -- the chat, its kind, what
 * is unread in it, what the other side is doing -- so they read as one phrase.
 * Air separates independent readouts, which is what the trailing group is: a
 * half-typed command has nothing to do with the clock beside it, and a dot
 * between them would claim otherwise. Neither is a powerline chevron; this
 * line has never drawn one.
 */
export const PHRASE_SEPARATOR = ' · ';
export const READOUT_SEPARATOR = '  ';
/** The least room worth leaving the chat title before dropping something else instead. */
const MINIMUM_TITLE_WIDTH = 8;

/** Every operator, back to the key that starts it. A map rather than a first letter, so an operator whose name and key ever diverge fails to compile instead of showing the wrong key. */
const OPERATOR_KEYS: Record<TOperator, string> = {
  [Operators.DELETE]: 'd',
  [Operators.YANK]: 'y',
  [Operators.CHANGE]: 'c',
};

/**
 * vim's showcmd, in vim's own order: register, count, operator, then whatever
 * keys are accumulated toward a binding.
 *
 * This is the one thing on the line that answers "why did nothing happen when
 * I pressed that?" -- a `d` waiting for a motion and a `"` waiting for a
 * register name both look, from the outside, exactly like a key that was
 * ignored.
 */
export const buildShowcmd = (opts: { engine: IEngineState }): string => {
  const { register, count, operator, pending } = opts.engine;
  return [
    register === null ? '' : `"${register}`,
    count === null ? '' : String(count),
    // The key, not the name: the engine stores 'delete', and echoing that back
    // would show a command nobody typed. showcmd exists to say "this is what
    // you have pressed so far", so it has to be in the same alphabet.
    operator === null ? '' : OPERATOR_KEYS[operator],
    pending.join(''),
  ].join('');
};

/**
 * Where the cursor sits in the history, as vim's ruler puts it.
 *
 * Cursor-relative rather than viewport-relative: this pane scrolls to follow
 * the cursor, so "how far down the cursor is" and "how far down the view is"
 * are the same question here, and the cursor is the one the state actually
 * knows.
 */
export const formatProgress = (opts: { position: number; total: number }): string => {
  const { position, total } = opts;
  if (total === 0) {
    return '';
  }
  // Nothing to scroll past: the whole history is one message.
  if (total === 1) {
    return 'All';
  }
  if (position <= 1) {
    return 'Top';
  }
  if (position >= total) {
    return 'Bot';
  }
  return `${Math.floor(((position - 1) / (total - 1)) * 100)}%`;
};

/**
 * The connection, as one column -- and nothing at all when it is fine.
 *
 * It used to draw a dim `●` for the healthy case, on the reasoning that a
 * glance should cost no reading. Then the online dot arrived, which is also a
 * `●` and sits immediately after it, so a connected client talking to someone
 * online read as `● ● Alice` -- two identical marks meaning unrelated things.
 *
 * Showing nothing is the better answer to the rule this already followed: the
 * good case must not draw the eye, and a mark that is always there draws it
 * every time while saying nothing. What is left is exactly the two states
 * worth interrupting for.
 */
export const formatConnection = (opts: { connection: TConnectionState }): { text: string; tone: TStatusTone } => {
  switch (opts.connection) {
    case 'connected': {
      return { text: '', tone: StatusTones.DIM };
    }
    case 'connecting': {
      return { text: '◐', tone: StatusTones.ACCENT };
    }
    default: {
      return { text: '✕', tone: StatusTones.ALERT };
    }
  }
};

/** A DM needs no tag; everything else does, because what a key does differs. */
export const formatPeerKind = (opts: { kind: { type: string; isBot: boolean } | undefined }): string => {
  const { kind } = opts;
  if (!kind) {
    return '';
  }
  if (kind.isBot) {
    return 'bot';
  }
  return kind.type === 'user' ? '' : kind.type;
};

export interface ISegmentGroup {
  segments: IStatusSegment[];
  /** Between members of this group. */
  separator: string;
  /**
   * What joins this group to the title, charged once and only while the group
   * still has a member. Charging it up front instead -- reserving both joins
   * whether or not their groups survive -- spends columns on separators that
   * are never drawn, and the title pays for them.
   */
  joinWidth: number;
}

/** The width of one group, joins included -- what the line spends on it. */
export const measureGroup = (opts: { group: ISegmentGroup }): number => {
  const { group } = opts;
  return group.segments.length === 0
    ? 0
    : group.segments.reduce((total, segment) => total + measureTextWidth({ text: segment.text }), 0)
      + (group.segments.length - 1) * measureTextWidth({ text: group.separator })
      + group.joinWidth;
};

/**
 * Drop the cheapest segments until every group fits the width between them,
 * then report what is left and how wide each came out.
 *
 * Across all groups at once, not group by group: fitting the trailing readouts
 * first and giving the rest what remained meant `\ for keys`, the least useful
 * thing on the line, outliving `3 unread` purely by being measured earlier.
 * Priority is a claim about the whole line or it is not a claim about
 * anything.
 *
 * Lowest priority first, and one at a time: dropping a whole priority band
 * would throw away a one-column segment to save a ten-column one it happened
 * to share a number with.
 */
export const fitGroups = (opts: { groups: ISegmentGroup[]; width: number }): {
  groups: ISegmentGroup[];
  width: number;
} => {
  const kept = opts.groups.map(group => ({
    ...group,
    segments: group.segments.filter(segment => segment.text !== ''),
  }));

  const measure = (groups: ISegmentGroup[]): number =>
    groups.reduce((total, group) => total + measureGroup({ group }), 0);

  const dropCheapest = (groups: ISegmentGroup[]): boolean => {
    let target: { group: number; index: number } | null = null;
    groups.forEach((group, groupIndex) => {
      group.segments.forEach((segment, index) => {
        // Ties break toward the later segment, so a line written in reading
        // order loses its tail first -- the same way the eye gives it up.
        if (target === null || segment.priority <= groups[target.group]!.segments[target.index]!.priority) {
          target = { group: groupIndex, index };
        }
      });
    });
    if (target === null) {
      return false;
    }
    const { group, index } = target as { group: number; index: number };
    groups[group]!.segments.splice(index, 1);
    return true;
  };

  while (measure(kept) > opts.width && dropCheapest(kept)) {
    // dropCheapest reports whether anything was left to drop; the loop stops
    // when it says no, rather than spinning on a width nothing can satisfy.
  }

  return { groups: kept, width: measure(kept) };
};

/**
 * Joined for rendering: one separator between neighbours, none at either end.
 *
 * Separators come out as their own dim spans rather than folded into the text
 * beside them, so a red over-limit count does not drag the dot in front of it
 * red as well.
 */
export const joinSegments = (opts: { segments: IStatusSegment[]; separator: string }): { text: string; tone: TStatusTone }[] =>
  opts.segments.flatMap((segment, index) => (index === 0
    ? [{ text: segment.text, tone: segment.tone }]
    : [{ text: opts.separator, tone: StatusTones.DIM }, { text: segment.text, tone: segment.tone }]));

export { MINIMUM_TITLE_WIDTH };
