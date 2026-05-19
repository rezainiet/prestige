// One-off: rewrite the stale support handle on the "Écris-moi en direct"
// line to the canonical @prest_original in already-stored data —
// site_settings (welcome + reminder copy, admin-edited) and queued
// telegram_reminder_jobs (messageText is materialized at schedule time, so
// the reminder worker sends it raw without re-rendering).
//
// Mirrors server/telegramReminders.ts normalizeDirectContact(). The code
// fix covers all FUTURE welcomes/reminders; this fixes the EXISTING rows.
//
// Usage (prod): railway run node scripts/normalize_direct_contact.mjs
//        dry run: railway run node scripts/normalize_direct_contact.mjs --dry
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}
const DRY = process.argv.includes("--dry");
const CANONICAL = "@prest_original";

function normalizeDirectContact(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/(Écris-moi en direct\s*:?\s*)@[A-Za-z0-9_]{2,}/g, `$1${CANONICAL}`)
    .replace(
      /(Écris-moi en direct\s*:?\s*)https?:\/\/t\.me\/[A-Za-z0-9_]{2,}/gi,
      `$1${CANONICAL}`,
    );
}

const SETTING_KEYS = [
  "welcome_message",
  "telegram_reminder_15m_message",
  "telegram_reminder_1h_message",
  "telegram_reminder_4h_message",
  "telegram_reminder_24h_message",
  "telegram_reminder_1w_message",
  "telegram_reminder_2w_message",
  "telegram_reminder_1m_message",
];

const conn = await mysql.createConnection(url);
let settingsChanged = 0;
let jobsChanged = 0;

try {
  // 1. site_settings copy
  for (const key of SETTING_KEYS) {
    const [rows] = await conn.execute(
      "SELECT setting_value FROM site_settings WHERE setting_key = ? LIMIT 1",
      [key],
    );
    if (!rows.length) continue;
    const current = rows[0].setting_value;
    const next = normalizeDirectContact(current);
    if (next === current) continue;
    settingsChanged += 1;
    console.log(`\n[site_settings:${key}]`);
    console.log("  before:", JSON.stringify(current.slice(-120)));
    console.log("  after :", JSON.stringify(next.slice(-120)));
    if (!DRY) {
      await conn.execute(
        "UPDATE site_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?",
        [next, key],
      );
    }
  }

  // 2. queued reminder jobs (messageText sent raw by the worker)
  const [jobs] = await conn.execute(
    `SELECT id, messageText FROM telegram_reminder_jobs
      WHERE status IN ('pending','processing','failed')`,
  );
  for (const job of jobs) {
    const next = normalizeDirectContact(job.messageText);
    if (next === job.messageText) continue;
    jobsChanged += 1;
    if (!DRY) {
      await conn.execute(
        "UPDATE telegram_reminder_jobs SET messageText = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?",
        [next, job.id],
      );
    }
  }

  console.log(
    `\n${DRY ? "[DRY RUN] " : ""}site_settings updated: ${settingsChanged} | reminder jobs updated: ${jobsChanged} (scanned ${jobs.length})`,
  );
} finally {
  await conn.end();
}
