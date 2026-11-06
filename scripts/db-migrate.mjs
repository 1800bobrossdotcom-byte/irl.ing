// Create or update irl.ing's tables (all prefixed irl_): first Better Auth's
// account tables, then the social tables in db/social.sql (safe to re-run).
//   DATABASE_URL=... BETTER_AUTH_SECRET=... node scripts/db-migrate.mjs         apply
//   DATABASE_URL=... BETTER_AUTH_SECRET=... node scripts/db-migrate.mjs --sql   print SQL only
import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { buildOptions, settings } from "../src/server/auth.js";

const s = settings();
if (!s.databaseUrl) {
  console.error("Set DATABASE_URL (your Neon connection string) first.");
  process.exit(1);
}
const options = buildOptions({ ...s, secret: s.secret || "migration-only" });
const socialSql = await readFile(new URL("../db/social.sql", import.meta.url), "utf8");
const { toBeCreated, toBeAdded, runMigrations, compileMigrations } = await getMigrations(options);
if (process.argv.includes("--sql")) {
  if (toBeCreated.length || toBeAdded.length) console.log(await compileMigrations());
  console.log(socialSql);
} else {
  if (!toBeCreated.length && !toBeAdded.length) {
    console.log("Account tables are up to date.");
  } else {
    await runMigrations();
    console.log(`Created ${toBeCreated.map((t) => t.table).join(", ") || "no tables"}; updated ${toBeAdded.map((t) => t.table).join(", ") || "no tables"}.`);
  }
  await options.database.query(socialSql);
  console.log("Social tables are up to date.");
}
await options.database.end();
