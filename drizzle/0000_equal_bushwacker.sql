CREATE TABLE `job_clicks` (
	`event_id` text PRIMARY KEY NOT NULL,
	`clicked_at` integer NOT NULL,
	`source` text NOT NULL,
	`job_key` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_job_clicks_clicked_at` ON `job_clicks` (`clicked_at`);