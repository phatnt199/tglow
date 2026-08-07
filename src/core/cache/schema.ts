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
    /**
     * Whether this message is pinned in its chat. Telegram carries it as a
     * flag on the message itself, so it arrives with every fetch and every
     * live delivery -- no separate lookup, and no risk of the marker
     * disagreeing with the server about a message already on screen.
     */
    pinned: integer('pinned').notNull().default(0),
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

/**
 * Telegram's own chat folders (`messages.getDialogFilters`), which every
 * graphical client shows as a rail down the left edge.
 *
 * A folder selects chats two ways at once: an explicit `includePeers` list, and
 * category flags like "all groups" or "everything unread". Both are stored --
 * the peer lists as JSON arrays of peer id, the flags as their own columns --
 * because membership is recomputed locally on every render and a round trip per
 * frame is not an option.
 *
 * `ord` is the position Telegram returned them in, kept because the order is
 * the user's own arrangement and sorting by id would scramble it.
 */
export const dialogFilters = sqliteTable('dialog_filters', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  emoticon: text('emoticon'),
  ord: integer('ord').notNull(),
  /** JSON arrays of peer id, in Telegram's own order. */
  pinnedPeers: text('pinned_peers').notNull().default('[]'),
  includePeers: text('include_peers').notNull().default('[]'),
  excludePeers: text('exclude_peers').notNull().default('[]'),
  /**
   * The category flags. Only those tglow can honestly evaluate from what it
   * caches are acted on -- see folder-service.ts, which says which and why.
   * The rest are stored anyway so a later version can start honouring them
   * without a second migration.
   */
  contacts: integer('contacts').notNull().default(0),
  nonContacts: integer('non_contacts').notNull().default(0),
  groups: integer('groups').notNull().default(0),
  broadcasts: integer('broadcasts').notNull().default(0),
  bots: integer('bots').notNull().default(0),
  excludeMuted: integer('exclude_muted').notNull().default(0),
  excludeRead: integer('exclude_read').notNull().default(0),
  excludeArchived: integer('exclude_archived').notNull().default(0),
});
