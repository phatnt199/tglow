import { readFileSync } from 'node:fs';

import { Database } from 'bun:sqlite';
import { getError } from '@venizia/ignis-inversion';

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

const SCHEMA_PATH = new URL('./schema.sql', import.meta.url).pathname;

export class DatabaseService {
  private _database: Database | null = null;

  private require = (methodName: string): Database => {
    if (!this._database) {
      throw getError({ message: `[DatabaseService][${methodName}] Database is not open` });
    }
    return this._database;
  };

  open = (opts: { filePath: string }): void => {
    this.close();
    const database = new Database(opts.filePath);
    database.run('PRAGMA journal_mode = WAL');
    database.run('PRAGMA foreign_keys = ON');
    database.run(readFileSync(SCHEMA_PATH, 'utf8'));
    this._database = database;
  };

  upsertPeer = (peer: IPeerInput): void => {
    this.require('upsertPeer')
      .prepare(
        `INSERT INTO peers (id, type, access_hash, title, username, updated_at)
         VALUES ($id, $type, $accessHash, $title, $username, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           type = $type, access_hash = $accessHash, title = $title,
           username = $username, updated_at = $updatedAt`,
      )
      .run({
        $id: peer.id,
        $type: peer.type,
        $accessHash: peer.accessHash,
        $title: peer.title,
        $username: peer.username,
        $updatedAt: Date.now(),
      });
  };

  upsertDialog = (dialog: IDialogInput): void => {
    this.require('upsertDialog')
      .prepare(
        `INSERT INTO dialogs (peer_id, pinned, unread_count, last_message_at, top_message_id)
         VALUES ($peerId, $pinned, $unreadCount, $lastMessageAt, $topMessageId)
         ON CONFLICT(peer_id) DO UPDATE SET
           pinned = $pinned, unread_count = $unreadCount,
           last_message_at = $lastMessageAt, top_message_id = $topMessageId`,
      )
      .run({
        $peerId: dialog.peerId,
        $pinned: dialog.pinned,
        $unreadCount: dialog.unreadCount,
        $lastMessageAt: dialog.lastMessageAt,
        $topMessageId: dialog.topMessageId,
      });
  };

  listDialogs = (): IDialogRow[] => {
    return this.require('listDialogs')
      .prepare(
        `SELECT d.peer_id AS peerId, p.title AS title, d.pinned AS pinned,
                d.unread_count AS unreadCount, d.last_message_at AS lastMessageAt,
                d.top_message_id AS topMessageId
         FROM dialogs d
         JOIN peers p ON p.id = d.peer_id
         ORDER BY d.pinned DESC, d.last_message_at DESC`,
      )
      .all() as IDialogRow[];
  };

  insertMessages = (opts: { messages: IMessageInput[] }): void => {
    const database = this.require('insertMessages');
    const statement = database.prepare(
      `INSERT INTO messages (peer_id, id, from_id, date, text, out)
       VALUES ($peerId, $id, $fromId, $date, $text, $out)
       ON CONFLICT(peer_id, id) DO UPDATE SET
         from_id = $fromId, date = $date, text = $text, out = $out`,
    );

    database.transaction((messages: IMessageInput[]) => {
      for (const message of messages) {
        statement.run({
          $peerId: message.peerId,
          $id: message.id,
          $fromId: message.fromId,
          $date: message.date,
          $text: message.text,
          $out: message.out,
        });
      }
    })(opts.messages);
  };

  listMessages = (opts: { peerId: string; limit: number }): IMessageRow[] => {
    return this.require('listMessages')
      .prepare(
        `SELECT peer_id AS peerId, id, from_id AS fromId, date, text, out
         FROM messages
         WHERE peer_id = $peerId AND deleted = 0
         ORDER BY date DESC, id DESC
         LIMIT $limit`,
      )
      .all({ $peerId: opts.peerId, $limit: opts.limit }) as IMessageRow[];
  };

  getSyncState = (opts: { key: string }): number | null => {
    const row = this.require('getSyncState')
      .prepare('SELECT value FROM sync_state WHERE key = $key')
      .get({ $key: opts.key }) as { value: number } | null;
    return row ? row.value : null;
  };

  setSyncState = (opts: { key: string; value: number }): void => {
    this.require('setSyncState')
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES ($key, $value)
         ON CONFLICT(key) DO UPDATE SET value = $value`,
      )
      .run({ $key: opts.key, $value: opts.value });
  };

  close = (): void => {
    this._database?.close();
    this._database = null;
  };
}
