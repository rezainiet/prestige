// One-shot migration: replay the last 7 days of successfully-sent Meta CAPI
// events onto the NEW pixel after a pixel switch.
//
// The pixel id lives only in the CAPI URL — every event's full payload is
// stored verbatim in meta_event_logs.requestPayloadJson — so replaying is
// just re-POSTing those payloads to the new pixel/token. We preserve the
// original event_id and event_time so attribution lands on the correct day
// and Meta's per-pixel dedup stays clean if this is ever re-run.
//
// Meta hard-rejects events whose event_time is older than 7 days, so that is
// exactly the replayable window. We filter at 6.9 days to avoid edge rejects
// for rows that age past the boundary mid-run.
//
// Usage (run INSIDE Railway — DATABASE_URL is internal-only):
//   railway ssh -s prestige -- node scripts/replay_meta_7d_to_new_pixel.mjs
//   railway ssh -s prestige -- node scripts/replay_meta_7d_to_new_pixel.mjs --apply
//
// Reads PIXEL/TOKEN from env (already switched to the new pixel in Railway).

import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");

const DB_URL = process.env.DATABASE_URL;
const PIXEL_ID = process.env.META_PIXEL_ID;
const ACCESS_TOKEN = process.env.META_CONVERSIONS_TOKEN;
if (!DB_URL || !PIXEL_ID || !ACCESS_TOKEN) {
  console.error("Set DATABASE_URL, META_PIXEL_ID, META_CONVERSIONS_TOKEN.");
  process.exit(1);
}
const CAPI_URL = `https://graph.facebook.com/v21.0/${PIXEL_ID}/events`;

const NOW = Math.floor(Date.now() / 1000);
const WINDOW_SECONDS = Math.floor(6.9 * 24 * 60 * 60); // 6.9d safety margin
const MIN_EVENT_TIME = NOW - WINDOW_SECONDS;

console.log(`Target pixel: ${PIXEL_ID}`);
console.log(`Replay window: event_time >= ${MIN_EVENT_TIME} (${new Date(MIN_EVENT_TIME * 1000).toISOString()})`);
console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);

const conn = await mysql.createConnection(DB_URL);

// Pull a generous superset by createdAt, then filter precisely on the payload's
// event_time (the value Meta actually validates against the 7-day rule).
const [rows] = await conn.query(
  `SELECT eventId, eventType, eventScope, telegramUserId, requestPayloadJson
     FROM meta_event_logs
    WHERE status = 'sent'
      AND requestPayloadJson IS NOT NULL
      AND createdAt >= NOW() - INTERVAL 9 DAY
    ORDER BY createdAt ASC`,
);

const replayable = [];
let skippedOld = 0;
let skippedBad = 0;

for (const r of rows) {
  let payload;
  try {
    payload = JSON.parse(r.requestPayloadJson);
  } catch {
    skippedBad++;
    continue;
  }
  const ev = payload?.data?.[0];
  const eventTime = Number(ev?.event_time);
  if (!ev || !Number.isFinite(eventTime)) {
    skippedBad++;
    continue;
  }
  if (eventTime < MIN_EVENT_TIME) {
    skippedOld++;
    continue;
  }
  // Never carry a test_event_code into a production replay.
  if (payload.test_event_code) delete payload.test_event_code;
  replayable.push({ ...r, payload, eventTime });
}

console.log(
  `Rows fetched=${rows.length} replayable=${replayable.length} ` +
    `skipped_old=${skippedOld} skipped_bad=${skippedBad}`,
);

if (!APPLY) {
  for (const r of replayable.slice(0, 20)) {
    console.log(
      `  [${r.eventType}/${r.eventScope}] ${r.eventId} uid=${r.telegramUserId} t=${new Date(r.eventTime * 1000).toISOString()}`,
    );
  }
  if (replayable.length > 20) console.log(`  ... +${replayable.length - 20} more`);
  console.log("\nDry-run only. Re-run with --apply to send to the new pixel.");
  await conn.end();
  process.exit(0);
}

let sent = 0;
let failed = 0;
const failures = [];

for (const r of replayable) {
  let httpStatus = null;
  let body = null;
  let netError = null;
  try {
    const res = await fetch(`${CAPI_URL}?access_token=${ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r.payload),
    });
    httpStatus = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    netError = err instanceof Error ? err.message : String(err);
  }

  const ok = httpStatus === 200 && body?.events_received === 1 && !body?.error;
  if (ok) {
    sent++;
  } else {
    failed++;
    const msg = body?.error?.message || netError || `HTTP ${httpStatus}`;
    failures.push({ eventId: r.eventId, msg });
    console.log(`✗ ${r.eventId} status=${httpStatus} err=${msg}`);
  }
  // Rate-limit so a burst doesn't trip Meta's throttle.
  await new Promise((res) => setTimeout(res, 200));
}

console.log(`\nDone. replayed_to_new_pixel sent=${sent} failed=${failed}`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures.slice(0, 30)) console.log(`  ${f.eventId}: ${f.msg}`);
}
await conn.end();
process.exit(failed > 0 ? 1 : 0);
