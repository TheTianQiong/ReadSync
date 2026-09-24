PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_book_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`version` integer NOT NULL,
	`size` integer NOT NULL,
	`md5` text NOT NULL,
	`object_key` text,
	`storage_id` integer,
	`note` text,
	`uploaded_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`storage_id`) REFERENCES `storages`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_book_versions`("id", "book_id", "version", "size", "md5", "object_key", "storage_id", "note", "uploaded_by", "created_at") SELECT "id", "book_id", "version", "size", "md5", "object_key", "storage_id", "note", "uploaded_by", "created_at" FROM `book_versions`;--> statement-breakpoint
DROP TABLE `book_versions`;--> statement-breakpoint
ALTER TABLE `__new_book_versions` RENAME TO `book_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `book_versions_unique` ON `book_versions` (`book_id`,`version`);--> statement-breakpoint
CREATE INDEX `book_versions_book_idx` ON `book_versions` (`book_id`);--> statement-breakpoint
CREATE TABLE `__new_books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`publisher` text,
	`isbn` text,
	`format` text DEFAULT 'epub' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`md5` text NOT NULL,
	`object_key` text,
	`storage_id` integer,
	`current_version` integer DEFAULT 1 NOT NULL,
	`cover_url` text,
	`description` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`language` text,
	`reading_status` text DEFAULT 'unread' NOT NULL,
	`progress_percent` integer DEFAULT 0 NOT NULL,
	`total_pages` integer,
	`total_words` integer,
	`total_reading_seconds` integer DEFAULT 0 NOT NULL,
	`last_read_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`storage_id`) REFERENCES `storages`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_books`("id", "owner_id", "title", "author", "publisher", "isbn", "format", "size", "md5", "object_key", "storage_id", "current_version", "cover_url", "description", "tags", "language", "reading_status", "progress_percent", "total_pages", "total_words", "total_reading_seconds", "last_read_at", "created_at", "updated_at") SELECT "id", "owner_id", "title", "author", "publisher", "isbn", "format", "size", "md5", "object_key", "storage_id", "current_version", "cover_url", "description", "tags", "language", "reading_status", "progress_percent", "total_pages", "total_words", "total_reading_seconds", "last_read_at", "created_at", "updated_at" FROM `books`;--> statement-breakpoint
DROP TABLE `books`;--> statement-breakpoint
ALTER TABLE `__new_books` RENAME TO `books`;--> statement-breakpoint
CREATE INDEX `books_owner_idx` ON `books` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `books_owner_md5_unique` ON `books` (`owner_id`,`md5`);--> statement-breakpoint
CREATE INDEX `books_storage_idx` ON `books` (`storage_id`);--> statement-breakpoint
CREATE INDEX `books_reading_status_idx` ON `books` (`reading_status`);--> statement-breakpoint
CREATE INDEX `books_last_read_idx` ON `books` (`last_read_at`);