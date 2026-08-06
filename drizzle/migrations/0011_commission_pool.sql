ALTER TABLE `clubs` ADD `commission_cap_rate` decimal(5,2);--> statement-breakpoint
ALTER TABLE `roles` ADD `pool_share` tinyint DEFAULT 0 NOT NULL;