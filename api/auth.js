// Vercel function for everything under /api/auth/* (see the rewrite in
// vercel.json). Until DATABASE_URL and BETTER_AUTH_SECRET are set, it answers
// that accounts aren't switched on yet instead of failing.

import { toNodeHandler } from "better-auth/node";
import { getAuth } from "../src/server/auth.js";

// Large enough for a shared loop (512 KB + three still frames, as base64),
// small enough that nothing else can push big bodies through.
const MAX_BODY = 2 * 1024 * 1024;

let handler = null;

export default async function auth(req, res) {
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
    res.statusCode = 413;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "That’s too big to send." }));
    return;
  }
  const instance = getAuth();
  if (!instance) {
    res.statusCode = req.url?.startsWith("/api/auth/irl/config") ? 200 : 503;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(res.statusCode === 200 ? { accounts: false } : { message: "Accounts aren’t switched on yet." }));
    return;
  }
  handler ??= toNodeHandler(instance);
  return handler(req, res);
}
