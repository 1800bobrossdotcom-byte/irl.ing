// Create or update irl.ing's tables (all prefixed irl_): first Better Auth's
// account tables, then the social tables in db/social.sql. Only ever adds
// tables and columns; safe to re-run.
//   DATABASE_URL=... BETTER_AUTH_SECRET=... node scripts/db-migrate.mjs         apply
//   DATABASE_URL=... BETTER_AUTH_SECRET=... node scripts/db-migrate.mjs --sql   print SQL only
//   node scripts/db-migrate.mjs --if-preview   apply only on a Vercel preview build
//
// --if-preview runs during Vercel builds (see vercel.json). Neon's Vercel
// integration gives each Git branch its own copy of the database, taken when
// the branch was first deployed, so a preview's copy can lack tables added
// since. Production is never touched this way: migrate it deliberately.
import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { buildOptions, settings } from "../src/server/auth.js";

const ifPreview = process.argv.includes("--if-preview");
if (ifPreview && process.env.VERCEL_ENV !== "preview") {
  console.log(`Skipping database migration (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}).`);
  process.exit(0);
}
const s = settings();
if (!s.databaseUrl) {
  console.error("Set DATABASE_URL (your Neon connection string) first.");
  process.exit(ifPreview ? 0 : 1);
}
if (ifPreview) {
  // A failed preview migration shouldn't block the preview build; the
  // deployment's /api/auth/irl/config will name what's missing.
  process.on("uncaughtException", (error) => {
    console.warn(`Preview database migration failed: ${error.code ?? ""} ${error.message}`);
    process.exit(0);
  });
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
