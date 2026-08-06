CREATE TABLE `dialog_filters` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`emoticon` text,
	`ord` integer NOT NULL,
	`pinned_peers` text DEFAULT '[]' NOT NULL,
	`include_peers` text DEFAULT '[]' NOT NULL,
	`exclude_peers` text DEFAULT '[]' NOT NULL,
	`contacts` integer DEFAULT 0 NOT NULL,
	`non_contacts` integer DEFAULT 0 NOT NULL,
	`groups` integer DEFAULT 0 NOT NULL,
	`broadcasts` integer DEFAULT 0 NOT NULL,
	`bots` integer DEFAULT 0 NOT NULL,
	`exclude_muted` integer DEFAULT 0 NOT NULL,
	`exclude_read` integer DEFAULT 0 NOT NULL,
	`exclude_archived` integer DEFAULT 0 NOT NULL
);
