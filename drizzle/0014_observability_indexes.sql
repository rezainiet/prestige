-- Observability indexes — applied via scripts/apply_migration_0014.mjs which
-- runs each CREATE INDEX through the MySQL driver and ignores ER_DUP_KEYNAME
-- (1061) so the migration stays idempotent.
--
-- DO NOT execute this file directly with `mysql < file.sql` — DELIMITER
-- handling differs between the CLI and the wire protocol. Use the script.
--
-- Indexes created (all are simple BTREE on existing columns, no data
-- rewrites — InnoDB online DDL handles them in seconds for tables this size):

CREATE INDEX `idx_tj_joinedAt_attribution` ON `telegram_joins` (`joinedAt`, `attributionStatus`);
CREATE INDEX `idx_tj_userId`               ON `telegram_joins` (`telegramUserId`);
CREATE INDEX `idx_bs_startedAt`            ON `bot_starts` (`startedAt`);
CREATE INDEX `idx_mel_createdAt`           ON `meta_event_logs` (`createdAt`);
CREATE INDEX `idx_mel_updatedAt`           ON `meta_event_logs` (`updatedAt`);
CREATE INDEX `idx_mel_status_type`         ON `meta_event_logs` (`status`, `eventType`);
CREATE INDEX `idx_mel_scope_status`        ON `meta_event_logs` (`eventScope`, `status`);
CREATE INDEX `idx_mel_telegramUserId`      ON `meta_event_logs` (`telegramUserId`);
CREATE INDEX `idx_te_eventType_createdAt`  ON `tracking_events` (`eventType`, `createdAt`);
