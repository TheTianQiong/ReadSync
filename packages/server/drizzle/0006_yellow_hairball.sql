CREATE TABLE `plugin_user_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plugin_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`config` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_user_config_unique` ON `plugin_user_config` (`plugin_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `plugin_user_config_user_idx` ON `plugin_user_config` (`user_id`);