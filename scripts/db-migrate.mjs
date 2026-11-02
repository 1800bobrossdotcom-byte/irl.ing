// Create or update the irl.ing account tables (all prefixed irl_).
//   DATABASE_URL=... BETTER_AUTH_SECRET=... node scripts/db-migrate.mjs         apply
//   DATABASE_URL=... BETTER_AUTH_SECRET=... node scripts/db-migrate.mjs --sql   print SQL only
import { getMigrations } from "better-auth/db/migration";
import { buildOptions, settings } from "../src/server/auth.js";

const s = settings();
if (!s.databaseUrl) {
  console.error("Set DATABASE_URL (your Neon connection string) first.");
  process.exit(1);
}
const options = buildOptions({ ...s, secret: s.secret || "migration-only" });
const { toBeCreated, toBeAdded, runMigrations, compileMigrations } = await getMigrations(options);
if (!toBeCreated.length && !toBeAdded.length) {
  console.log("Account tables are up to date.");
} else if (process.argv.includes("--sql")) {
  console.log(await compileMigrations());
} else {
  await runMigrations();
  console.log(`Created ${toBeCreated.map((t) => t.table).join(", ") || "no tables"}; updated ${toBeAdded.map((t) => t.table).join(", ") || "no tables"}.`);
}
await options.database.end();
