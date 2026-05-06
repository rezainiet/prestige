// Update telegram_group_url site_setting + rewrite every welcome/reminder
// template AND every pending reminder job's messageText to point at the new
// gated invite link. Idempotent.
import mysql from "mysql2/promise";

const NEW_URL = process.argv[2];
if (!NEW_URL || !NEW_URL.startsWith("https://t.me/")) {
  console.error("Usage: node sync_group_url_to_new_invite.mjs https://t.me/+...");
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error("DATABASE_URL missing"); process.exit(1); }

const conn = await mysql.createConnection(dbUrl);

const TELEGRAM_INVITE_URL_RE = /https?:\/\/(?:t|telegram)\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+/gi;
const BOT_TEXT_KEYS = [
  "welcome_message",
  "telegram_reminder_15m_message",
  "telegram_reminder_1h_message",
  "telegram_reminder_4h_message",
  "telegram_reminder_24h_message",
  "telegram_reminder_1w_message",
  "telegram_reminder_2w_message",
  "telegram_reminder_1m_message",
];

function rewrite(text) {
  return text.replaceAll("{group_url}", NEW_URL).replace(TELEGRAM_INVITE_URL_RE, NEW_URL);
}

// 1. Upsert telegram_group_url
await conn.execute(
  `INSERT INTO site_settings (setting_key, setting_value)
   VALUES ('telegram_group_url', ?)
   ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
  [NEW_URL],
);
console.log(`✓ telegram_group_url = ${NEW_URL}`);

// 2. Rewrite every bot text setting
for (const key of BOT_TEXT_KEYS) {
  const [rows] = await conn.execute(
    `SELECT setting_value FROM site_settings WHERE setting_key = ? LIMIT 1`,
    [key],
  );
  const current = rows[0]?.setting_value;
  if (!current) {
    console.log(`  - ${key} (no row, skipped)`);
    continue;
  }
  const updated = rewrite(current);
  if (updated === current) {
    console.log(`  · ${key} (already fresh)`);
    continue;
  }
  await conn.execute(
    `UPDATE site_settings SET setting_value = ? WHERE setting_key = ?`,
    [updated, key],
  );
  console.log(`  ✓ ${key} rewritten`);
}

// 3. Rewrite every pending reminder job's messageText
const [pending] = await conn.query(
  `SELECT id, messageText FROM telegram_reminder_jobs
    WHERE status IN ('pending','processing','failed')`,
);
let rewroteJobs = 0;
for (const job of pending) {
  const updated = rewrite(job.messageText);
  if (updated === job.messageText) continue;
  await conn.execute(
    `UPDATE telegram_reminder_jobs SET messageText = ?, updatedAt = NOW() WHERE id = ?`,
    [updated, job.id],
  );
  rewroteJobs++;
}
console.log(`✓ rewrote ${rewroteJobs}/${pending.length} pending reminder jobs`);

// 4. Sanity verification — any old invite URL still in site_settings?
const [stale] = await conn.query(
  `SELECT setting_key, setting_value FROM site_settings
    WHERE setting_value REGEXP 't\\\\.me/(\\\\+|joinchat/)'
      AND setting_value NOT LIKE ?`,
  [`%${NEW_URL}%`],
);
if (stale.length === 0) {
  console.log("✓ no stale invite URLs in site_settings");
} else {
  console.log("⚠ stale invite URLs in site_settings:");
  for (const r of stale) console.log(`  - ${r.setting_key}: ${r.setting_value.slice(0, 100)}`);
}

const [staleJobs] = await conn.query(
  `SELECT COUNT(*) AS n FROM telegram_reminder_jobs
    WHERE status IN ('pending','processing','failed')
      AND messageText REGEXP 't\\\\.me/(\\\\+|joinchat/)'
      AND messageText NOT LIKE ?`,
  [`%${NEW_URL}%`],
);
console.log(`✓ stale invite URLs in pending reminder jobs: ${staleJobs[0].n}`);

// 5. Personal invite links cached on bot_starts — these are bot-minted
// per-user URLs, NOT the static admin URL we just replaced. They route through
// chat_join_request and the bot approves only known users, so we leave them
// alone. List a sample for sanity.
const [pers] = await conn.query(
  `SELECT COUNT(*) AS n FROM bot_starts WHERE personalInviteLink IS NOT NULL`,
);
console.log(`ℹ personal invite links cached on bot_starts: ${pers[0].n} (untouched)`);

await conn.end();
console.log("\nDone.");
