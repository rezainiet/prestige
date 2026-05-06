CREATE TABLE IF NOT EXISTS `telegram_join_request_audit` (
  `id` int NOT NULL AUTO_INCREMENT,
  `telegramUserId` varchar(64) NOT NULL,
  `telegramUsername` varchar(128) NULL,
  `telegramFirstName` varchar(128) NULL,
  `channelId` varchar(64) NOT NULL,
  `decision` enum('approved','declined') NOT NULL,
  `reason` varchar(128) NULL,
  `hadBotStart` int NOT NULL DEFAULT 0,
  `inviteLinkName` varchar(128) NULL,
  `decidedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_jra_decided_at` (`decidedAt`),
  KEY `idx_jra_user` (`telegramUserId`)
);
