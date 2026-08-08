import { Database } from 'bun:sqlite';
import { getError } from '@venizia/ignis-inversion';
import { and, desc, eq, like, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import type { ITelegramEntity } from '../common/index.ts';
import { describeMedia, type IMessageMedia, type TMediaKind } from '../media.ts';
import type { IMessageReaction } from '../reactions.ts';
import { runMigrations } from './migrate.ts';
import { dialogFilters, dialogs, messages, peers, syncState } from './schema.ts';

export interface IPeerInput {
  id: string;
  type: 'user' | 'chat' | 'channel';
  accessHash: string | null;
  title: string;
  username: string | null;
}

export interface IDialogInput {
  peerId: string;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number;
  topMessageId: number;
  /** The highest id of the user's own messages the other side has read. Drives the tick in message-view.tsx; unrelated to markRead, which moves the inbox pointer instead. */
  readOutboxMaxId: number;
}

export interface IMessageInput {
  peerId: string;
  id: number;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
  entities: ITelegramEntity[];
  replyToMessageId: number | null;
  /** 1 when pinned in its chat; omitted means not pinned. */
  pinned?: number;
  /** What the message carries besides text; omitted or null means text only. */
  media?: IMessageMedia | null;
  /** Who reacted with what; omitted means nobody has. */
  reactions?: IMessageReaction[];
}

export interface IDialogRow {
  peerId: string;
  title: string;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number | null;
  topMessageId: number | null;
  /** See IDialogInput.readOutboxMaxId. */
  readOutboxMaxId: number;
  /**
   * The text of the chat's newest cached message, for the preview line every
   * graphical Telegram client shows under a chat's name.
   *
   * Null when the cache has nothing for that chat -- a dialog fetched by
   * `DialogService.sync()` whose history has never been opened, which is most
   * of the list on a first run. The view shows nothing rather than a
   * placeholder: an empty second line reads as "not loaded", where "No
   * messages" would be a claim tglow cannot make.
   */
  preview: string | null;
}

/** A Telegram chat folder, as stored and as read back. Booleans here, integers in SQLite. */
export interface IFolderInput {
  id: number;
  title: string;
  emoticon: string | null;
  ord: number;
  pinnedPeers: string[];
  includePeers: string[];
  excludePeers: string[];
  contacts: boolean;
  nonContacts: boolean;
  groups: boolean;
  broadcasts: boolean;
  bots: boolean;
  excludeMuted: boolean;
  excludeRead: boolean;
  excludeArchived: boolean;
}

export type IFolderRow = IFolderInput;

/**
 * A stored peer list back into an array. Unreadable JSON costs that folder its
 * explicit members and nothing more -- throwing would cost the whole rail, and
 * a folder is not worth failing to start over.
 */
const parsePeerList = (opts: { raw: string }): string[] => {
  try {
    const parsed: unknown = JSON.parse(opts.raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
};

export interface IMessageRow {
  peerId: string;
  id: number;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
  entities: ITelegramEntity[];
  replyToMessageId: number | null;
  /** 1 when pinned in its chat. Optional on input so existing call sites need no change; always present on a row read back. */
  pinned?: number;
  /**
   * What the message carries besides text, or null when it is only text.
   *
   * Stored in the mediaKind/mediaJson columns the M1 schema reserved: the kind
   * separately from the rest so a later "show me only the photos" can filter
   * in SQL rather than parsing every row's JSON to find out.
   */
  media?: IMessageMedia | null;
  /** Who reacted with what. Always an array on a row read back, empty when nobody has. */
  reactions?: IMessageReaction[];
}

export type TDrizzleDatabase = ReturnType<typeof drizzle>;

/**
 * SQLite's LIKE treats `%` (any run of characters, including none) and `_`
 * (any single character) as wildcards -- a user searching cached messages for
 * a literal "50%" or "a_b" must get exactly that back as literal text, not
 * "50" followed by anything or "a" then any one character then "b"
 * (searchMessages below, M1b-2 Task 9). Escaping the escape character itself
 * first is what keeps a literal backslash already in the query from
 * corrupting the two substitutions that follow it -- escaping % or _ before
 * the backslash would re-escape the very backslashes those just introduced.
 */
const LIKE_ESCAPE_CHARACTER = '\\';

const escapeLikePattern = (opts: { value: string }): string => {
  return opts.value
    .replaceAll(LIKE_ESCAPE_CHARACTER, LIKE_ESCAPE_CHARACTER + LIKE_ESCAPE_CHARACTER)
    .replaceAll('%', LIKE_ESCAPE_CHARACTER + '%')
    .replaceAll('_', LIKE_ESCAPE_CHARACTER + '_');
};

/** The column shape listMessages and searchMessages both select -- one place, so the two can never quietly diverge on what an IMessageRow actually reads off the table. */
const MESSAGE_COLUMNS = {
  peerId: messages.peerId,
  id: messages.id,
  fromId: messages.fromId,
  date: messages.date,
  text: messages.text,
  out: messages.out,
  entities: messages.entities,
  replyToMessageId: messages.replyToMsgId,
  pinned: messages.pinned,
  mediaKind: messages.mediaKind,
  mediaJson: messages.mediaJson,
  reactions: messages.reactions,
};

/**
 * The raw row shape a MESSAGE_COLUMNS select produces, before toMessageRows
 * below applies the same two transforms listMessages always has. Derived
 * from IMessageRow rather than restating every field: only `text` and
 * `entities` actually differ (still nullable strings, pre-parse).
 */
type TMessageSelection = Omit<IMessageRow, 'text' | 'entities' | 'media' | 'reactions'>
  & {
    text: string | null; entities: string | null;
    mediaKind: string | null; mediaJson: string | null; reactions: string | null;
  };

const toMessageRows = (opts: { rows: TMessageSelection[] }): IMessageRow[] => {
  return opts.rows.map(row => ({
    ...row,
    // `text` is nullable at the schema level to leave room for media-only
    // messages in a later milestone; M1a always writes a string, so the row
    // shape here still promises non-null text to its caller.
    text: row.text as string,
    // Written as JSON since M1a; nothing wrote it before this task, so an
    // existing row's column reads back SQL NULL rather than '[]' -- callers
    // downstream iterate this without a null check, so it must never surface
    // as null here.
    entities: row.entities ? (JSON.parse(row.entities) as ITelegramEntity[]) : [],
    // mediaKind is the column that decides, not mediaJson: a media type with
    // no detail worth storing (a location) still has a kind and would
    // otherwise read back as no media at all.
    media: row.mediaKind
      ? { ...(row.mediaJson ? (JSON.parse(row.mediaJson) as IMessageMedia) : {}), kind: row.mediaKind as TMediaKind }
      : null,
    // Same reasoning as entities above: rows written before this column
    // existed read back SQL NULL, and every caller iterates this without a
    // null check.
    reactions: row.reactions ? (JSON.parse(row.reactions) as IMessageReaction[]) : [],
  }));
};

export class DatabaseService {
  private _database: TDrizzleDatabase | null = null;

  private require = (methodName: string): TDrizzleDatabase => {
    if (!this._database) {
      throw getError({ message: `[DatabaseService][${methodName}] Database is not open` });
    }
    return this._database;
  };

  open = (opts: { filePath: string }): void => {
    this.close();
    const connection = new Database(opts.filePath);
    connection.run('PRAGMA journal_mode = WAL');
    connection.run('PRAGMA foreign_keys = ON');
    const database = drizzle(connection);
    runMigrations({ database });
    this._database = database;
  };

  upsertPeer = (peer: IPeerInput): void => {
    const updatedAt = Date.now();
    this.require('upsertPeer')
      .insert(peers)
      .values({
        id: peer.id,
        type: peer.type,
        accessHash: peer.accessHash,
        title: peer.title,
        username: peer.username,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: peers.id,
        set: {
          type: peer.type,
          accessHash: peer.accessHash,
          title: peer.title,
          username: peer.username,
          updatedAt,
        },
      })
      .run();
  };

  upsertDialog = (dialog: IDialogInput): void => {
    this.require('upsertDialog')
      .insert(dialogs)
      .values({
        peerId: dialog.peerId,
        pinned: dialog.pinned,
        unreadCount: dialog.unreadCount,
        lastMessageAt: dialog.lastMessageAt,
        topMessageId: dialog.topMessageId,
        readOutboxMaxId: dialog.readOutboxMaxId,
      })
      .onConflictDoUpdate({
        target: dialogs.peerId,
        set: {
          pinned: dialog.pinned,
          unreadCount: dialog.unreadCount,
          lastMessageAt: dialog.lastMessageAt,
          topMessageId: dialog.topMessageId,
          readOutboxMaxId: dialog.readOutboxMaxId,
        },
      })
      .run();
  };

  /**
   * A direct UPDATE rather than a read-modify-write through upsertDialog:
   * the caller (MessageService.markRead) has no reason to know or preserve
   * pinned/lastMessageAt/topMessageId/readOutboxMaxId just to zero one
   * column, and a read-then-write would cost a round trip this doesn't need.
   * A peer with no dialog row yet -- markRead racing ahead of
   * DialogService.sync()'s first fetch -- matches zero rows and is a no-op,
   * not an error.
   */
  /** A direct UPDATE, the same shape clearUnreadCount uses -- and a no-op for a chat the dialog list has never carried. */
  setDialogPinned = (opts: { peerId: string; pinned: number }): void => {
    this.require('setDialogPinned')
      .update(dialogs)
      .set({ pinned: opts.pinned })
      .where(eq(dialogs.peerId, opts.peerId))
      .run();
  };

  clearUnreadCount = (opts: { peerId: string }): void => {
    this.require('clearUnreadCount')
      .update(dialogs)
      .set({ unreadCount: 0 })
      .where(eq(dialogs.peerId, opts.peerId))
      .run();
  };

  /**
   * A direct UPDATE for the same reason clearUnreadCount is one, and for a
   * second reason of its own: the `<` in the WHERE makes the advance monotonic
   * in SQL. Read receipts carry no ordering guarantee -- an update that arrives
   * later can carry a lower maxId than one already applied -- and a
   * read-modify-write would need its own comparison to keep the ticks from
   * walking backwards.
   *
   * A peer with no dialog row yet matches zero rows and is a no-op, which is
   * the wanted behaviour rather than a gap: upsertDialog would have to invent
   * pinned/lastMessageAt/topMessageId for a chat the dialog list has never
   * seen, putting a phantom row with a zero timestamp into the sidebar.
   */
  advanceReadOutboxMaxId = (opts: { peerId: string; maxId: number }): void => {
    this.require('advanceReadOutboxMaxId')
      .update(dialogs)
      .set({ readOutboxMaxId: opts.maxId })
      .where(and(eq(dialogs.peerId, opts.peerId), lt(dialogs.readOutboxMaxId, opts.maxId)))
      .run();
  };

  /**
   * Folders are replaced wholesale rather than upserted: Telegram sends the
   * complete set every time, and a folder the user deleted has to disappear
   * here too. Upserting would leave it in the rail forever, since nothing else
   * would ever remove a row.
   *
   * In one transaction, so a failure part-way cannot leave the rail empty --
   * the delete having run and the insert not.
   */
  replaceFolders = (opts: { folders: IFolderInput[] }): void => {
    this.require('replaceFolders').transaction(transaction => {
      transaction.delete(dialogFilters).run();
      for (const folder of opts.folders) {
        transaction
          .insert(dialogFilters)
          .values({
            id: folder.id,
            title: folder.title,
            emoticon: folder.emoticon,
            ord: folder.ord,
            pinnedPeers: JSON.stringify(folder.pinnedPeers),
            includePeers: JSON.stringify(folder.includePeers),
            excludePeers: JSON.stringify(folder.excludePeers),
            contacts: folder.contacts ? 1 : 0,
            nonContacts: folder.nonContacts ? 1 : 0,
            groups: folder.groups ? 1 : 0,
            broadcasts: folder.broadcasts ? 1 : 0,
            bots: folder.bots ? 1 : 0,
            excludeMuted: folder.excludeMuted ? 1 : 0,
            excludeRead: folder.excludeRead ? 1 : 0,
            excludeArchived: folder.excludeArchived ? 1 : 0,
          })
          .run();
      }
    });
  };

  listFolders = (): IFolderRow[] => {
    return this.require('listFolders')
      .select()
      .from(dialogFilters)
      .orderBy(dialogFilters.ord)
      .all()
      .map(row => ({
        id: row.id,
        title: row.title,
        emoticon: row.emoticon,
        ord: row.ord,
        // A folder whose JSON is unreadable becomes an empty list rather than
        // throwing: it costs that folder its explicit members, where a throw
        // would cost the whole rail.
        pinnedPeers: parsePeerList({ raw: row.pinnedPeers }),
        includePeers: parsePeerList({ raw: row.includePeers }),
        excludePeers: parsePeerList({ raw: row.excludePeers }),
        contacts: row.contacts === 1,
        nonContacts: row.nonContacts === 1,
        groups: row.groups === 1,
        broadcasts: row.broadcasts === 1,
        bots: row.bots === 1,
        excludeMuted: row.excludeMuted === 1,
        excludeRead: row.excludeRead === 1,
        excludeArchived: row.excludeArchived === 1,
      }));
  };

  /** Peer type and bot-ness for every cached peer, which folder membership needs and IDialogRow does not carry. */
  listPeerKinds = (): Map<string, { type: string; isBot: boolean }> => {
    const rows = this.require('listPeerKinds')
      .select({ id: peers.id, type: peers.type, isBot: peers.isBot })
      .from(peers)
      .all();
    return new Map(rows.map(row => [row.id, { type: row.type, isBot: row.isBot === 1 }]));
  };

  /**
   * The inbox mirror of advanceReadOutboxMaxId, and the reason tglow's badge
   * follows a chat read on another device. Monotonic in SQL for the same
   * reason: read updates carry no ordering guarantee.
   *
   * unreadCount is written from the server's own stillUnreadCount rather than
   * computed. tglow cannot derive it -- it does not know how many of the
   * messages at or below maxId it had ever counted -- and the one number
   * Telegram sends is authoritative for every device.
   */
  advanceReadInboxMaxId = (opts: { peerId: string; maxId: number; unreadCount: number }): void => {
    this.require('advanceReadInboxMaxId')
      .update(dialogs)
      .set({ readInboxMaxId: opts.maxId, unreadCount: opts.unreadCount })
      .where(and(eq(dialogs.peerId, opts.peerId), lt(dialogs.readInboxMaxId, opts.maxId)))
      .run();
  };

  listDialogs = (): IDialogRow[] => {
    const rows = this.require('listDialogs')
      .select({
        peerId: dialogs.peerId,
        title: peers.title,
        pinned: dialogs.pinned,
        unreadCount: dialogs.unreadCount,
        lastMessageAt: dialogs.lastMessageAt,
        topMessageId: dialogs.topMessageId,
        readOutboxMaxId: dialogs.readOutboxMaxId,
        // A correlated subquery rather than a join to `messages`: joining would
        // multiply each dialog by its message count and need a GROUP BY to
        // collapse again, and the newest row is not necessarily topMessageId --
        // that column tracks what the server last reported, which a message
        // arriving live can already be ahead of.
        //
        // `deleted` is filtered here for the same reason listMessages filters
        // it: a deleted message stays cached (removing it would leave a hole in
        // the id range history paging reasons about) and must not go on
        // previewing itself in the sidebar.
        preview: sql<string | null>`(
          SELECT ${messages.text} FROM ${messages}
          WHERE ${messages.peerId} = ${dialogs.peerId} AND ${messages.deleted} = 0
          ORDER BY ${messages.date} DESC, ${messages.id} DESC
          LIMIT 1
        )`,
        // The same row's media kind, so a chat whose newest message is a photo
        // previews as a photo rather than as a blank line -- which is exactly
        // what it did, since a media message's text is the empty string.
        previewMediaKind: sql<string | null>`(
          SELECT ${messages.mediaKind} FROM ${messages}
          WHERE ${messages.peerId} = ${dialogs.peerId} AND ${messages.deleted} = 0
          ORDER BY ${messages.date} DESC, ${messages.id} DESC
          LIMIT 1
        )`,
      })
      .from(dialogs)
      .innerJoin(peers, eq(peers.id, dialogs.peerId))
      .orderBy(desc(dialogs.pinned), desc(dialogs.lastMessageAt))
      .all();

    return rows.map(({ previewMediaKind, ...row }) => ({
      ...row,
      // The caption wins when there is one: "📷 Photo" says less than whatever
      // the sender wrote under it, and a caption is already the summary they
      // chose. Only a media message with no text at all falls back to naming
      // its kind.
      preview: row.preview && row.preview !== ''
        ? row.preview
        : previewMediaKind
          ? describeMedia({ media: { kind: previewMediaKind as TMediaKind } })
          : row.preview,
    }));
  };

  insertMessages = (opts: { messages: IMessageInput[] }): void => {
    this.require('insertMessages').transaction(transaction => {
      for (const message of opts.messages) {
        transaction
          .insert(messages)
          .values({
            peerId: message.peerId,
            id: message.id,
            fromId: message.fromId,
            date: message.date,
            text: message.text,
            out: message.out,
            entities: JSON.stringify(message.entities),
            replyToMsgId: message.replyToMessageId,
            pinned: message.pinned ?? 0,
            mediaKind: message.media?.kind ?? null,
            mediaJson: message.media ? JSON.stringify(message.media) : null,
            reactions: message.reactions && message.reactions.length > 0 ? JSON.stringify(message.reactions) : null,
          })
          .onConflictDoUpdate({
            target: [messages.peerId, messages.id],
            set: {
              fromId: message.fromId,
              date: message.date,
              text: message.text,
              out: message.out,
              entities: JSON.stringify(message.entities),
              replyToMsgId: message.replyToMessageId,
              pinned: message.pinned ?? 0,
              mediaKind: message.media?.kind ?? null,
              mediaJson: message.media ? JSON.stringify(message.media) : null,
              reactions: message.reactions && message.reactions.length > 0 ? JSON.stringify(message.reactions) : null,
            },
          })
          .run();
      }
    });
  };

  /** Wholesale, because Telegram sends the whole set on every change rather than a delta. Empty writes NULL, the same as a message nobody has reacted to. */
  setMessageReactions = (opts: { peerId: string; id: number; reactions: IMessageReaction[] }): void => {
    this.require('setMessageReactions')
      .update(messages)
      .set({ reactions: opts.reactions.length > 0 ? JSON.stringify(opts.reactions) : null })
      .where(and(eq(messages.peerId, opts.peerId), eq(messages.id, opts.id)))
      .run();
  };

  /** A direct UPDATE, the same shape clearUnreadCount uses: one column, and a no-op when the row is not cached. */
  setMessagePinned = (opts: { peerId: string; id: number; pinned: number }): void => {
    this.require('setMessagePinned')
      .update(messages)
      .set({ pinned: opts.pinned })
      .where(and(eq(messages.peerId, opts.peerId), eq(messages.id, opts.id)))
      .run();
  };

  listMessages = (opts: { peerId: string; limit: number }): IMessageRow[] => {
    const rows = this.require('listMessages')
      .select(MESSAGE_COLUMNS)
      .from(messages)
      .where(and(eq(messages.peerId, opts.peerId), eq(messages.deleted, 0)))
      .orderBy(desc(messages.date), desc(messages.id))
      .limit(opts.limit)
      .all();

    return toMessageRows({ rows });
  };

  /**
   * `/`, M1b-2 Task 9: a cached-only substring search over one peer's
   * messages, case-insensitive (SQLite's own default LIKE behaviour for
   * ASCII) and excluding deleted rows, same as listMessages. Server-side and
   * FTS5 search are M3 -- this stays a plain LIKE over the existing `messages`
   * table, no new index or virtual table.
   *
   * The query never reaches the SQL text itself: `like()` binds `pattern` as
   * an ordinary parameter (verified via `.toSQL()` -- the compiled statement
   * carries a `?` placeholder, not the query's own characters), the same way
   * every other method here passes a value through eq()/.values() rather than
   * string-building. The `ESCAPE '\'` suffix is static SQL text appended via
   * `sql`, not user input -- only the already-parameterized `pattern` sits
   * inside it.
   */
  searchMessages = (opts: { peerId: string; query: string; limit: number }): IMessageRow[] => {
    const pattern = `%${escapeLikePattern({ value: opts.query })}%`;
    const rows = this.require('searchMessages')
      .select(MESSAGE_COLUMNS)
      .from(messages)
      .where(and(
        eq(messages.peerId, opts.peerId),
        eq(messages.deleted, 0),
        sql`${like(messages.text, pattern)} ESCAPE '\\'`,
      ))
      .orderBy(desc(messages.date), desc(messages.id))
      .limit(opts.limit)
      .all();

    return toMessageRows({ rows });
  };

  /**
   * Flags the row rather than running a real DELETE: removing it would open
   * a hole in the peer's id range, which is exactly the fact history paging
   * (scrolling past the top of a contiguous range) reasons about to tell
   * "cached" from "never fetched". listMessages already excludes deleted=1,
   * so this alone is what makes a deleted message stop appearing.
   */
  deleteMessage = (opts: { peerId: string; id: number }): void => {
    this.require('deleteMessage')
      .update(messages)
      .set({ deleted: 1 })
      .where(and(eq(messages.peerId, opts.peerId), eq(messages.id, opts.id)))
      .run();
  };

  getSyncState = (opts: { key: string }): number | null => {
    const row = this.require('getSyncState')
      .select({ value: syncState.value })
      .from(syncState)
      .where(eq(syncState.key, opts.key))
      .get();
    return row ? row.value : null;
  };

  setSyncState = (opts: { key: string; value: number }): void => {
    this.require('setSyncState')
      .insert(syncState)
      .values({ key: opts.key, value: opts.value })
      .onConflictDoUpdate({ target: syncState.key, set: { value: opts.value } })
      .run();
  };

  close = (): void => {
    this._database?.$client.close();
    this._database = null;
  };
}
