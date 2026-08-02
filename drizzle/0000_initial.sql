CREATE TABLE `dialogs` (
	`peer_id` text PRIMARY KEY NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`unread_mentions` integer DEFAULT 0 NOT NULL,
	`read_inbox_max_id` integer DEFAULT 0 NOT NULL,
	`read_outbox_max_id` integer DEFAULT 0 NOT NULL,
	`top_message_id` integer,
	`last_message_at` integer,
	`muted_until` integer DEFAULT 0 NOT NULL,
	`folder_id` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`peer_id`) REFERENCES `peers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_dialogs_order` ON `dialogs` (`pinned`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`peer_id` text NOT NULL,
	`id` integer NOT NULL,
	`from_id` text,
	`date` integer NOT NULL,
	`edit_date` integer,
	`text` text,
	`entities` text,
	`reply_to_msg_id` integer,
	`fwd_from` text,
	`media_kind` text,
	`media_json` text,
	`out` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`peer_id`, `id`),
	FOREIGN KEY (`peer_id`) REFERENCES `peers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_peer_date` ON `messages` (`peer_id`,`date`);--> statement-breakpoint
CREATE TABLE `peers` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`access_hash` text,
	`title` text NOT NULL,
	`username` text,
	`is_self` integer DEFAULT 0 NOT NULL,
	`is_bot` integer DEFAULT 0 NOT NULL,
	`status` text,
	`status_seen_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
