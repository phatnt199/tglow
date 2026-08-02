import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const peers = sqliteTable('peers', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  accessHash: text('access_hash'),
  title: text('title').notNull(),
  username: text('username'),
  isSelf: integer('is_self').notNull().default(0),
  isBot: integer('is_bot').notNull().default(0),
  status: text('status'),
  statusSeenAt: integer('status_seen_at'),
  updatedAt: integer('updated_at').notNull(),
});

export const dialogs = sqliteTable(
  'dialogs',
  {
    peerId: text('peer_id').primaryKey().references(() => peers.id),
    pinned: integer('pinned').notNull().default(0),
    unreadCount: integer('unread_count').notNull().default(0),
    unreadMentions: integer('unread_mentions').notNull().default(0),
    readInboxMaxId: integer('read_inbox_max_id').notNull().default(0),
    readOutboxMaxId: integer('read_outbox_max_id').notNull().default(0),
    topMessageId: integer('top_message_id'),
    lastMessageAt: integer('last_message_at'),
    mutedUntil: integer('muted_until').notNull().default(0),
    folderId: integer('folder_id').notNull().default(0),
  },
  table => [index('idx_dialogs_order').on(table.pinned, table.lastMessageAt)],
);

export const messages = sqliteTable(
  'messages',
  {
    peerId: text('peer_id').notNull().references(() => peers.id),
    id: integer('id').notNull(),
    fromId: text('from_id'),
    date: integer('date').notNull(),
    editDate: integer('edit_date'),
    text: text('text'),
    entities: text('entities'),
    replyToMsgId: integer('reply_to_msg_id'),
    fwdFrom: text('fwd_from'),
    mediaKind: text('media_kind'),
    mediaJson: text('media_json'),
    out: integer('out').notNull().default(0),
    deleted: integer('deleted').notNull().default(0),
  },
  table => [
    primaryKey({ columns: [table.peerId, table.id] }),
    index('idx_messages_peer_date').on(table.peerId, table.date),
  ],
);

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: integer('value').notNull(),
});
