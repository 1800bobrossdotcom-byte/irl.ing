// Print a fresh random secret for BETTER_AUTH_SECRET (or any other secret).
//   npm run secret            → 32 random bytes, base64url (43 characters)
//   npm run secret -- 48      → 48 random bytes
// Paste it straight into Vercel → Settings → Environment Variables.
// Don't commit it, share it in chat, or reuse it between projects.

import { randomBytes } from "node:crypto";

const bytes = Number(process.argv[2] ?? 32);
if (!Number.isInteger(bytes) || bytes < 32 || bytes > 128) {
  console.error("Use between 32 and 128 bytes.");
  process.exit(1);
}
console.log(randomBytes(bytes).toString("base64url"));
