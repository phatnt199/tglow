import { EntityKinds, type ITelegramEntity, type TEntityKind } from '../core/common/index.ts';
import { toGraphemes } from './text-width.ts';

export interface IStyledSpan {
  text: string;
  kinds: TEntityKind[];
  url: string | null;
}

interface IGraphemeBoundary {
  grapheme: string;
  startUnit: number;
}

/**
 * Telegram entity offsets are UTF-16 code units; tglow renders graphemes. This
 * builds one boundary table up front and never indexes the raw string by an
 * entity offset, which would split an emoji or a combining sequence. Each
 * grapheme's `startUnit` is the UTF-16 unit its first code unit lives at, so
 * covering(entity) below always includes or excludes a grapheme as a whole.
 */
const buildGraphemeBoundaries = (opts: { text: string }): IGraphemeBoundary[] => {
  const boundaries: IGraphemeBoundary[] = [];
  let unit = 0;

  for (const { grapheme } of toGraphemes({ text: opts.text })) {
    boundaries.push({ grapheme, startUnit: unit });
    unit += grapheme.length; // .length is UTF-16 code units, which is what Telegram counts
  }

  return boundaries;
};

/** Entities malformed enough that no grapheme could ever fall inside them. */
const isUsable = (entity: ITelegramEntity): boolean => entity.length > 0 && entity.offset >= 0;

const covers = (opts: { entity: ITelegramEntity; startUnit: number }): boolean => {
  const { entity, startUnit } = opts;
  return startUnit >= entity.offset && startUnit < entity.offset + entity.length;
};

/**
 * A single grapheme's styling, resolved from every entity that covers it. An
 * `unknown` kind is stripped here rather than filtered out of the entity list
 * up front, so a known entity nested inside an unrecognised one still
 * renders -- only the unrecognised entity's own contribution disappears,
 * kind and url both, which is what "degrades to plain text" has to mean for
 * a url: an unstyled span is not a link.
 */
const resolveStyle = (opts: { entities: ITelegramEntity[]; startUnit: number }): { kinds: TEntityKind[]; url: string | null } => {
  const covering = opts.entities.filter(entity => covers({ entity, startUnit: opts.startUnit }));
  const known = covering.filter(entity => entity.kind !== EntityKinds.UNKNOWN);

  // A set in substance: Telegram would not send the same kind twice over one
  // run, but nothing here depends on that, and IStyledSpan's kinds is typed
  // as an array rather than a Set, so dedup on the way in instead.
  const kinds = Array.from(new Set(known.map(entity => entity.kind)));
  const url = known.find(entity => entity.url !== undefined)?.url ?? null;

  return { kinds, url };
};

const styleSignature = (style: { kinds: TEntityKind[]; url: string | null }): string => {
  return `${[...style.kinds].sort().join(',')}|${style.url ?? ''}`;
};

/**
 * Splits `text` into runs of uniform styling. Every grapheme from the
 * boundary table is appended to exactly one span, so concatenating the
 * result's `text` fields always reproduces the input verbatim -- true for any
 * entity list, including an empty or entirely out-of-range one, since
 * entities only ever change how graphemes are grouped, never whether they
 * are emitted.
 */
export const toStyledSpans = (opts: { text: string; entities: ITelegramEntity[] }): IStyledSpan[] => {
  const { text, entities } = opts;

  // Mirrors wrapText's one-row-for-empty-input guarantee: a downstream
  // renderer always has a span to key a row on, even for a blank message.
  if (text === '') {
    return [{ text: '', kinds: [], url: null }];
  }

  const usable = entities.filter(isUsable);
  const spans: IStyledSpan[] = [];
  let current: IStyledSpan | null = null;
  let currentSignature = '';

  for (const { grapheme, startUnit } of buildGraphemeBoundaries({ text })) {
    const style = resolveStyle({ entities: usable, startUnit });
    const signature = styleSignature(style);

    if (current && signature === currentSignature) {
      current.text += grapheme;
      continue;
    }

    current = { text: grapheme, kinds: style.kinds, url: style.url };
    currentSignature = signature;
    spans.push(current);
  }

  return spans;
};
