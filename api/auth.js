// Vercel function for everything under /api/auth/* (see the rewrite in
// vercel.json). Until DATABASE_URL and BETTER_AUTH_SECRET are set, it answers
// that accounts aren't switched on yet instead of failing.

import { toNodeHandler } from "better-auth/node";
import { getAuth } from "../src/server/auth.js";

let handler = null;

export default async function auth(req, res) {
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
