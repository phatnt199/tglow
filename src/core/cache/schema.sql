CREATE TABLE IF NOT EXISTS peers (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  access_hash    TEXT,
  title          TEXT NOT NULL,
  username       TEXT,
  is_self        INTEGER NOT NULL DEFAULT 0,
  is_bot         INTEGER NOT NULL DEFAULT 0,
  status         TEXT,
  status_seen_at INTEGER,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dialogs (
  peer_id            TEXT PRIMARY KEY REFERENCES peers(id),
  pinned             INTEGER NOT NULL DEFAULT 0,
  unread_count       INTEGER NOT NULL DEFAULT 0,
  unread_mentions    INTEGER NOT NULL DEFAULT 0,
  read_inbox_max_id  INTEGER NOT NULL DEFAULT 0,
  read_outbox_max_id INTEGER NOT NULL DEFAULT 0,
  top_message_id     INTEGER,
  last_message_at    INTEGER,
  muted_until        INTEGER NOT NULL DEFAULT 0,
  folder_id          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dialogs_order
  ON dialogs(pinned DESC, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  peer_id         TEXT NOT NULL REFERENCES peers(id),
  id              INTEGER NOT NULL,
  from_id         TEXT,
  date            INTEGER NOT NULL,
  edit_date       INTEGER,
  text            TEXT,
  entities        TEXT,
  reply_to_msg_id INTEGER,
  fwd_from        TEXT,
  media_kind      TEXT,
  media_json      TEXT,
  out             INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (peer_id, id)
);

CREATE INDEX IF NOT EXISTS idx_messages_peer_date
  ON messages(peer_id, date DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
