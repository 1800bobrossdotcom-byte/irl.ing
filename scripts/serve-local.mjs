// Local stand-in for Vercel: serves dist/ and runs api/auth.js for
// /api/auth/*, so accounts can be tested end to end against local Postgres.
//   npm run build && PORT=3004 DATABASE_URL=... BETTER_AUTH_SECRET=... node scripts/serve-local.mjs
// With LOCAL_STORAGE_DIR set (and MODERATION_JUDGE=stub or ANTHROPIC_API_KEY),
// loop sharing works too: loops are kept in that directory and played back
// through signed, expiring /api/dev-storage/* links, as R2 would serve them.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import auth from "../api/auth.js";
import { settings } from "../src/server/auth.js";
import { getStorage } from "../src/server/storage.js";

const root = new URL("../dist/", import.meta.url).pathname;
const port = Number(process.env.PORT ?? 3004);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };
const s = settings();
const storage = getStorage(process.env, { baseURL: s.baseURL, secret: s.secret });
const storageTypes = { ".irl": "application/octet-stream", ".jpg": "image/jpeg" };

async function devStorage(req, res) {
  const url = new URL(req.url, "http://x");
  const key = decodeURIComponent(url.pathname.slice("/api/dev-storage/".length));
  if (storage?.kind !== "local" || req.method !== "GET" || !storage.verify("GET", key, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  const bytes = await storage.get(key);
  if (!bytes) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": storageTypes[extname(key)], "cache-control": "private, max-age=600", "access-control-allow-origin": s.baseURL });
  res.end(bytes);
}

createServer((req, res) => {
  if (req.url.startsWith("/api/auth/")) {
    req.headers["x-real-ip"] = req.socket.remoteAddress; // as Vercel does
    return auth(req, res);
  }
  if (req.url.startsWith("/api/dev-storage/")) return devStorage(req, res).catch(() => res.writeHead(500).end());
  let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, path);
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`irl.ing local on http://localhost:${port}`));
