PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reading_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`book_id` integer,
	`document` text,
	`platform` text DEFAULT 'other' NOT NULL,
	`device` text DEFAULT 'unknown' NOT NULL,
	`seconds` integer DEFAULT 0 NOT NULL,
	`day` text NOT NULL,
	`hour` integer,
	`weekday` integer DEFAULT 0 NOT NULL,
	`progress_percent` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_reading_sessions`("id", "user_id", "book_id", "document", "platform", "device", "seconds", "day", "hour", "weekday", "progress_percent", "started_at", "ended_at", "created_at") SELECT "id", "user_id", "book_id", "document", "platform", "device", "seconds", "day", "hour", "weekday", "progress_percent", "started_at", "ended_at", "created_at" FROM `reading_sessions`;--> statement-breakpoint
DROP TABLE `reading_sessions`;--> statement-breakpoint
ALTER TABLE `__new_reading_sessions` RENAME TO `reading_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `reading_sessions_user_day_idx` ON `reading_sessions` (`user_id`,`day`);--> statement-breakpoint
CREATE INDEX `reading_sessions_user_idx` ON `reading_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `reading_sessions_book_idx` ON `reading_sessions` (`book_id`);--> statement-breakpoint
CREATE INDEX `reading_sessions_platform_idx` ON `reading_sessions` (`platform`);