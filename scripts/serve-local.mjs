// Local stand-in for Vercel: serves dist/ and runs api/auth.js for
// /api/auth/*, so accounts can be tested end to end against local Postgres.
//   npm run build && PORT=3004 DATABASE_URL=... BETTER_AUTH_SECRET=... node scripts/serve-local.mjs
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import auth from "../api/auth.js";

const root = new URL("../dist/", import.meta.url).pathname;
const port = Number(process.env.PORT ?? 3004);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };

createServer((req, res) => {
  if (req.url.startsWith("/api/auth/")) {
    req.headers["x-real-ip"] = req.socket.remoteAddress; // as Vercel does
    return auth(req, res);
  }
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
