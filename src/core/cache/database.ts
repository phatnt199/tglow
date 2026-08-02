import { Database } from 'bun:sqlite';
import { getError } from '@venizia/ignis-inversion';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';

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
}

export interface IMessageInput {
  peerId: string;
  id: number;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
}

export interface IDialogRow {
  peerId: string;
  title: string;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number | null;
  topMessageId: number | null;
}

export interface IMessageRow {
  peerId: string;
  id: number;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
}

export type TDrizzleDatabase = ReturnType<typeof drizzle>;

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
      })
      .onConflictDoUpdate({
        target: dialogs.peerId,
        set: {
          pinned: dialog.pinned,
          unreadCount: dialog.unreadCount,
          lastMessageAt: dialog.lastMessageAt,
          topMessageId: dialog.topMessageId,
        },
      })
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
          })
          .onConflictDoUpdate({
            target: [messages.peerId, messages.id],
            set: {
              fromId: message.fromId,
              date: message.date,
              text: message.text,
              out: message.out,
            },
          })
          .run();
      }
    });
  };

  listMessages = (opts: { peerId: string; limit: number }): IMessageRow[] => {
    // `text` is nullable at the schema level to leave room for media-only
    // messages in a later milestone; M1a always writes a string, so the row
    // shape here still promises non-null text to its caller.
    return this.require('listMessages')
      .select({
        peerId: messages.peerId,
        id: messages.id,
        fromId: messages.fromId,
        date: messages.date,
        text: messages.text,
        out: messages.out,
      })
      .from(messages)
      .where(and(eq(messages.peerId, opts.peerId), eq(messages.deleted, 0)))
      .orderBy(desc(messages.date), desc(messages.id))
      .limit(opts.limit)
      .all() as IMessageRow[];
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
