import { Database } from 'bun:sqlite';
import { getError } from '@venizia/ignis-inversion';
import { and, desc, eq, like, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import type { ITelegramEntity } from '../common/index.ts';
import { runMigrations } from './migrate.ts';
import { dialogs, messages, peers, syncState } from './schema.ts';

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
}

export interface IMessageRow {
  peerId: string;
  id: number;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
  entities: ITelegramEntity[];
  replyToMessageId: number | null;
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
};

/**
 * The raw row shape a MESSAGE_COLUMNS select produces, before toMessageRows
 * below applies the same two transforms listMessages always has. Derived
 * from IMessageRow rather than restating every field: only `text` and
 * `entities` actually differ (still nullable strings, pre-parse).
 */
type TMessageSelection = Omit<IMessageRow, 'text' | 'entities'> & { text: string | null; entities: string | null };

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
    return this.require('listDialogs')
      .select({
        peerId: dialogs.peerId,
        title: peers.title,
        pinned: dialogs.pinned,
        unreadCount: dialogs.unreadCount,
        lastMessageAt: dialogs.lastMessageAt,
        topMessageId: dialogs.topMessageId,
        readOutboxMaxId: dialogs.readOutboxMaxId,
      })
      .from(dialogs)
      .innerJoin(peers, eq(peers.id, dialogs.peerId))
      .orderBy(desc(dialogs.pinned), desc(dialogs.lastMessageAt))
      .all();
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
            },
          })
          .run();
      }
    });
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
