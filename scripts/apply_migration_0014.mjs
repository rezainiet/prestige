// Apply 0014_observability_indexes.sql idempotently. Each CREATE INDEX runs
// in its own statement; MySQL error 1061 (ER_DUP_KEYNAME) means the index
// already exists — treat as success.
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }

const sqlPath = path.resolve(process.cwd(), "drizzle/0014_observability_indexes.sql");
const raw = fs.readFileSync(sqlPath, "utf-8");

// Strip comments + split on `;` outside strings. Our migration is plain DDL,
// no DELIMITER, no procedure bodies — naive split is correct here.
const statements = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const conn = await mysql.createConnection(url);
let created = 0;
let existed = 0;
let failed = 0;
for (const stmt of statements) {
  try {
    await conn.query(stmt);
    created++;
    console.log(`✓ ${stmt.slice(0, 100)}…`);
  } catch (err) {
    if (err && err.errno === 1061) {
      existed++;
      console.log(`· already exists: ${stmt.match(/`(idx_[^`]+)`/)?.[1] ?? "?"}`);
    } else {
      failed++;
      console.error(`✗ ${stmt.slice(0, 100)}…`);
      console.error(`  ${err?.code ?? "?"} ${err?.message ?? err}`);
    }
  }
}
console.log(`\nIndexes created=${created} already-existed=${existed} failed=${failed}`);

const tables = ["telegram_joins", "bot_starts", "meta_event_logs", "tracking_events"];
for (const t of tables) {
  const [rows] = await conn.query(
    `SELECT index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ?
      GROUP BY index_name ORDER BY index_name`,
    [t],
  );
  console.log(`\n${t}:`);
  for (const r of rows) console.log(`  ${r.index_name}: (${r.cols})`);
}

await conn.end();
process.exit(failed === 0 ? 0 : 1);
