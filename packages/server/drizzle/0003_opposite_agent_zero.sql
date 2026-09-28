CREATE TABLE `book_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`document_id` text NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_documents_unique` ON `book_documents` (`book_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `book_documents_book_idx` ON `book_documents` (`book_id`);