DELETE FROM `gsc_connections`;--> statement-breakpoint
DELETE FROM `ga4_connections`;--> statement-breakpoint
DROP INDEX `ga4_connections_connector_idx`;--> statement-breakpoint
ALTER TABLE `ga4_connections` DROP COLUMN `connected_by_user_id`;--> statement-breakpoint
ALTER TABLE `ga4_connections` DROP COLUMN `ga4_account_id`;--> statement-breakpoint
ALTER TABLE `ga4_connections` DROP COLUMN `connected_account_email`;--> statement-breakpoint
ALTER TABLE `gsc_connections` DROP COLUMN `connected_by_user_id`;--> statement-breakpoint
ALTER TABLE `gsc_connections` DROP COLUMN `gsc_account_id`;--> statement-breakpoint
ALTER TABLE `gsc_connections` DROP COLUMN `connected_account_email`;