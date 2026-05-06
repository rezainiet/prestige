// Backfill Subscribe events for telegram_joins and bot_starts rows that never
// fired Meta CAPI. Targets the ~42 pre-f4eb0e7 bypass joins plus any orphan
// bot_starts with metaSubscribeStatus='pending' and no meta_event_log row.
//
// Usage:
//   DATABASE_URL=... META_PIXEL_ID=... META_CONVERSIONS_TOKEN=... \
//     node scripts/backfill_missing_subscribes.mjs            # dry-run, prints candidates
//   ... --apply                                              # process oldest 10
//   ... --apply --limit 50                                   # process oldest 50
//   ... --apply --limit 200 --all                            # process all candidates
//
// Idempotency: event_id = `tg_backfill_<uid>_<channel>` is stable per user,
// so re-runs dedupe at Meta even if this script is invoked twice.
//
// Safety: each event hits Meta CAPI individually with a 200ms gap. Stop with
// ctrl-c at any time — already-sent rows have meta_event_logs entries and
// won't re-fire.

import crypto from "node:crypto";
import mysql from "mysql2/promise";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL = args.includes("--all");
const limitFlag = args.findIndex((a) => a === "--limit");
const LIMIT = limitFlag >= 0 ? Number(args[limitFlag + 1]) : ALL ? 1000 : 10;

const DB_URL = process.env.DATABASE_URL;
const PIXEL_ID = process.env.META_PIXEL_ID;
const ACCESS_TOKEN = process.env.META_CONVERSIONS_TOKEN;
if (!DB_URL || !PIXEL_ID || !ACCESS_TOKEN) {
  console.error("Set DATABASE_URL, META_PIXEL_ID, META_CONVERSIONS_TOKEN.");
  process.exit(1);
}
const CAPI_URL = `https://graph.facebook.com/v21.0/${PIXEL_ID}/events`;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value).toLowerCase().trim()).digest("hex");
}

const conn = await mysql.createConnection(DB_URL);

// Candidate set: every (telegramUserId, channelId) pair that joined or /started
// but has no Subscribe in meta_event_logs with status='sent'. Joined join rows
// take priority because they also need metaEventSent updated.
const fallbackChannelId = process.env.TELEGRAM_CHANNEL_ID || "-1003843266944";
const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(LIMIT) || 10)));
const [candidates] = await conn.query(
  `
  SELECT
    'join' AS source,
    j.telegramUserId,
    j.telegramUsername,
    j.telegramFirstName,
    j.telegramLastName,
    j.channelId,
    UNIX_TIMESTAMP(j.joinedAt) AS event_time,
    j.sessionToken,
    j.funnelToken,
    j.fbclid,
    j.fbp,
    j.utmSource, j.utmMedium, j.utmCampaign, j.utmContent,
    j.ipAddress, j.userAgent
  FROM telegram_joins j
  WHERE NOT EXISTS (
    SELECT 1 FROM meta_event_logs e
    WHERE e.telegramUserId = j.telegramUserId
      AND e.eventType = 'Subscribe'
      AND e.status = 'sent'
  )
  UNION ALL
  SELECT
    'start' AS source,
    b.telegramUserId,
    b.telegramUsername,
    b.telegramFirstName,
    NULL AS telegramLastName,
    ? AS channelId,
    UNIX_TIMESTAMP(b.firstStartedAt) AS event_time,
    b.sessionToken,
    b.funnelToken,
    b.fbclid,
    b.fbp,
    b.utmSource, b.utmMedium, b.utmCampaign, b.utmContent,
    NULL AS ipAddress, NULL AS userAgent
  FROM bot_starts b
  WHERE b.metaSubscribeStatus IN ('pending','failed','abandoned')
    AND NOT EXISTS (
      SELECT 1 FROM meta_event_logs e
      WHERE e.telegramUserId = b.telegramUserId
        AND e.eventType = 'Subscribe'
        AND e.status = 'sent'
    )
  ORDER BY event_time ASC
  LIMIT ${safeLimit}
  `,
  [fallbackChannelId],
);

console.log(`Candidates: ${candidates.length} (limit=${LIMIT}, apply=${APPLY})`);
if (!APPLY) {
  for (const c of candidates) {
    console.log(
      `  [${c.source}] uid=${c.telegramUserId} channel=${c.channelId} ts=${c.event_time} session=${c.sessionToken ? "y" : "n"} fbclid=${c.fbclid ? "y" : "n"}`,
    );
  }
  console.log("\nDry-run only. Re-run with --apply to send.");
  await conn.end();
  process.exit(0);
}

async function loadSession(sessionToken, funnelToken) {
  if (sessionToken) {
    const [rows] = await conn.execute(
      `SELECT visitorId, fbclid, fbp, utmSource, utmMedium, utmCampaign, utmContent,
              ipAddress, userAgent, landingPage, createdAt
         FROM utm_sessions WHERE sessionToken = ? LIMIT 1`,
      [sessionToken],
    );
    if (rows[0]) return rows[0];
  }
  if (funnelToken) {
    const [rows] = await conn.execute(
      `SELECT visitorId, fbclid, fbp, utmSource, utmMedium, utmCampaign, utmContent,
              ipAddress, userAgent, landingPage, createdAt
         FROM utm_sessions WHERE funnelToken = ? ORDER BY createdAt DESC LIMIT 1`,
      [funnelToken],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

function buildFbc(fbclid, sessionCreatedAt) {
  if (!fbclid || !sessionCreatedAt) return undefined;
  const ts = new Date(sessionCreatedAt).getTime();
  return Number.isFinite(ts) ? `fb.1.${ts}.${fbclid}` : undefined;
}

let sent = 0;
let failed = 0;
let skipped = 0;

for (const c of candidates) {
  const eventId = `tg_backfill_${c.telegramUserId}_${String(c.channelId).replace(/-/g, "n")}`;

  // Pre-existing log row?
  const [existingLog] = await conn.execute(
    `SELECT status FROM meta_event_logs WHERE eventId = ? LIMIT 1`,
    [eventId],
  );
  if (existingLog[0]?.status === "sent") {
    skipped++;
    continue;
  }

  const session = await loadSession(c.sessionToken, c.funnelToken);

  const userData = {
    external_id: sha256(session?.visitorId || c.telegramUserId),
  };
  const ip = session?.ipAddress || (c.ipAddress && c.ipAddress !== "91.108.5.37" ? c.ipAddress : null);
  const ua = session?.userAgent || c.userAgent || null;
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  const fbp = session?.fbp || c.fbp;
  if (fbp) userData.fbp = fbp;
  const fbc = buildFbc(session?.fbclid || c.fbclid, session?.createdAt);
  if (fbc) userData.fbc = fbc;
  if (c.telegramFirstName) userData.fn = sha256(c.telegramFirstName);
  if (c.telegramLastName) userData.ln = sha256(c.telegramLastName);

  const customData = {
    content_name: "Telegram Channel Join",
    content_category: "Telegram",
    value: "0.00",
    currency: "EUR",
    predicted_ltv: "0.00",
    telegram_user_id: String(c.telegramUserId),
    backfill: "1",
  };
  if (session?.utmCampaign || c.utmCampaign) customData.utm_campaign = session?.utmCampaign || c.utmCampaign;
  if (session?.utmSource || c.utmSource) customData.utm_source = session?.utmSource || c.utmSource;
  if (session?.utmMedium || c.utmMedium) customData.utm_medium = session?.utmMedium || c.utmMedium;
  if (session?.utmContent || c.utmContent) customData.utm_content = session?.utmContent || c.utmContent;
  if (c.telegramUsername) customData.telegram_username = c.telegramUsername;

  const payload = {
    data: [
      {
        event_name: "Subscribe",
        event_time: Number(c.event_time),
        event_id: eventId,
        event_source_url: session?.landingPage || "https://prestige-production-1c6c.up.railway.app",
        action_source: "website",
        user_data: userData,
        custom_data: customData,
      },
    ],
  };

  // Insert a queued log row first so a crash mid-flight doesn't lose the event.
  await conn.execute(
    `INSERT IGNORE INTO meta_event_logs (eventType, eventScope, eventId, telegramUserId, status, retryable, attemptCount, requestPayloadJson, createdAt)
     VALUES ('Subscribe', 'backfill', ?, ?, 'queued', 0, 0, ?, NOW())`,
    [eventId, c.telegramUserId, JSON.stringify(payload)],
  );

  let httpStatus = null;
  let body = null;
  let netError = null;
  try {
    const res = await fetch(`${CAPI_URL}?access_token=${ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    httpStatus = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    netError = err instanceof Error ? err.message : String(err);
  }

  const ok = httpStatus === 200 && body?.events_received === 1 && !body?.error;
  const status = ok ? "sent" : "failed";
  const errorMessage = body?.error?.message || netError || (httpStatus !== 200 ? `HTTP ${httpStatus}` : null);

  await conn.execute(
    `UPDATE meta_event_logs SET
       status = ?,
       httpStatus = ?,
       responsePayloadJson = ?,
       errorCode = ?,
       errorMessage = ?,
       attemptCount = 1,
       attemptedAt = NOW(),
       completedAt = ?
       WHERE eventId = ?`,
    [
      status,
      httpStatus,
      body ? JSON.stringify(body) : null,
      body?.error?.code != null ? String(body.error.code) : null,
      errorMessage,
      ok ? new Date() : null,
      eventId,
    ],
  );

  if (ok) {
    sent++;
    if (c.source === "join") {
      await conn.execute(
        `UPDATE telegram_joins SET metaEventSent='sent', metaEventId=?, metaEventSentAt=NOW()
         WHERE telegramUserId=? AND channelId=?`,
        [eventId, c.telegramUserId, c.channelId],
      );
    } else {
      await conn.execute(
        `UPDATE bot_starts SET metaSubscribeStatus='sent', metaSubscribeEventId=?, metaSubscribeSentAt=NOW()
         WHERE telegramUserId=?`,
        [eventId, c.telegramUserId],
      );
    }
    console.log(`✓ ${c.source} uid=${c.telegramUserId} sent (${eventId})`);
  } else {
    failed++;
    console.log(`✗ ${c.source} uid=${c.telegramUserId} FAILED status=${httpStatus} err=${errorMessage}`);
  }

  // Rate-limit so a burst of 50 backfills doesn't trip Meta's throttle.
  await new Promise((r) => setTimeout(r, 200));
}

console.log(`\nDone. sent=${sent} failed=${failed} skipped=${skipped}`);
await conn.end();
