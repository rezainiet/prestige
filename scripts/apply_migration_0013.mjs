import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const sqlPath = path.resolve(process.cwd(), "drizzle/0013_telegram_join_request_audit.sql");
const sql = fs.readFileSync(sqlPath, "utf-8");

const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
console.log(`Applying ${sqlPath}`);
console.log(sql);
await conn.query(sql);
const [rows] = await conn.query(`SHOW CREATE TABLE telegram_join_request_audit`);
console.log("\nResulting table:");
console.log(rows[0]["Create Table"]);
await conn.end();
console.log("\n✓ Migration 0013 applied.");
