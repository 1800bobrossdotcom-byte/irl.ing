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
  let instance;
  try {
    instance = getAuth();
  } catch (error) {
    return failed(res, error);
  }
  if (!instance) {
    res.statusCode = req.url?.startsWith("/api/auth/irl/config") ? 200 : 503;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(res.statusCode === 200 ? { accounts: false } : { message: "Accounts aren’t switched on yet." }));
    return;
  }
  handler ??= toNodeHandler(instance);
  try {
    await handler(req, res);
  } catch (error) {
    failed(res, error);
  }
}

/**
 * Answer with a clean error instead of crashing the function. The response
 * names only the error's code (a Postgres SQLSTATE such as 28P01, or a
 * network code such as ENOTFOUND), never its message, which can contain
 * connection details. The full error goes to the function log.
 */
function failed(res, error) {
  console.error("[irl] auth request failed:", error);
  if (res.headersSent) {
    res.end();
    return;
  }
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(error.code) ? error.code : "UNKNOWN";
  res.statusCode = 500;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const body = { message: "Accounts are temporarily unavailable.", code };
  // Which tables or columns the database lacks: irl.ing's own (public) schema, safe to show.
  if (code === "SCHEMA_MISMATCH" && Array.isArray(error.findings)) {
    body.missing = error.findings.map((f) => `${f.kind}: ${f.table}${f.column ? `.${f.column}` : ""}`);
    body.fix = "Run npm run db:migrate against this database (or redeploy the preview, which does it).";
  }
  res.end(JSON.stringify(body));
}
