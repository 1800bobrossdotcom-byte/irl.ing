# Accounts: passkey-first, password-free

irl.ing accounts run on [Better Auth](https://www.better-auth.com/) 1.7.10 with Postgres (Neon in production), as a single Vercel function at `/api/auth/*`. There are no passwords and no phone numbers.

## The flow (about 30 seconds)

1. **Claim your @name.** Pick a handle, an optional display name and a birthday (month and year), and agree to the community rules.
   - The server checks the handle (3–20 of a–z, 0–9, `_`, `.`; starts with a letter; not reserved; not taken).
   - The server checks age: under 13 is refused and nothing is stored.
   - It then holds the claim for 15 minutes.
2. **Save it to this phone.** A passkey is created with the phone’s fingerprint, face or screen lock.
   - The server **requires** that check (WebAuthn user verification) on top of the plugin’s defaults.
   - Only then is the account created, in one transaction with the passkey and the first session.
3. **You’re in.** Accounts start friends-only. Under-18s can’t be found by strangers and can’t switch that on. "Invite a friend" shares a link.

**Signing in** is one button using the passkey, which Android also syncs through Google Password Manager. **Signing out** and **deleting the account** are in the account sheet.

- Deletion asks you to type your @name.
- It needs a session from the last 10 minutes.
- It removes the account, its passkeys and its sessions, and frees the @name.

## What’s stored

| Table | Contents |
| --- | --- |
| `irl_user` | id, @handle, display name, visibility (`friends`), discoverable, `adultFrom` (the month the person turns 18; not the birthday), timestamps. Passkey-only accounts get a placeholder email at `@passkey.irl.invalid`, which can never receive mail and is never shown. |
| `irl_passkey` | public key, credential id, counter, device type, backup state. No biometrics: those never leave the phone. |
| `irl_session` | session token, expiry, IP and user agent of the session (for security). |
| `irl_verification` | short-lived WebAuthn challenges and @name claims. |
| `irl_rate_limit` | request counters. |
| `irl_account` | created by Better Auth, unused (no social or password logins). |

The schema is in `db/schema.sql`. Every table is prefixed `irl_`, so the database can be shared without clashes.

## Security

- **Phishing-resistant sign-in:** passkeys are bound to the site’s domain and need the fingerprint, face or screen-lock check, enforced server-side by `requireUserVerified()` for registration and sign-in.
- **Cookies:** `HttpOnly`, `Secure` on HTTPS, `SameSite=Lax`, prefixed `irl`. Origin checks on every state-changing request come from Better Auth.
- **Rate limits** are stored in Postgres so they hold across serverless instances. They key on Vercel’s `x-real-ip`, with tighter limits on claims, passkey verification and deletion.
- **Optional bot check:** Cloudflare Turnstile on claims, switched on by `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY`.
- **Every rule is enforced by the server.** The browser’s copy in `src/accounts/rules.js` is only instant feedback.

## Switching it on in Vercel

1. **Database.** Connecting Neon to the project (Storage tab) sets the connection string. It's found under `DATABASE_URL`, `POSTGRES_URL`, or the same names with a custom prefix such as `irl_POSTGRES_URL`; the pooled address is always used. It must apply to Production as well as Preview.
2. **Secret.** Add `BETTER_AUTH_SECRET`, ticking **both** Production and Preview. Generate it with `npm run secret` (or `openssl rand -base64 32`).
3. **Tables.** Paste `db/schema.sql` into Neon’s SQL editor, or run `DATABASE_URL="…" BETTER_AUTH_SECRET="…" npm run db:migrate`.
4. **Redeploy.**

The **Claim your @name** button appears in the loops lab once `/api/auth/irl/config` reports `accounts: true`. Until then the lab works exactly as before and no button shows.

Passkeys are tied to the domain they were made on. Production uses `irl.ing`; each Vercel preview uses its own deployment URL, so preview accounts don’t carry over.

## Testing

```sh
# Local Postgres, then:
export DATABASE_URL=postgres://postgres@localhost:5433/irling BETTER_AUTH_SECRET=dev-secret-at-least-32-characters-long BETTER_AUTH_URL=http://localhost:3004
npm run db:migrate && npm run build && node scripts/serve-local.mjs &
SITE_URL=http://localhost:3004 node tests/accounts-browser.mjs
```

The browser test drives real WebAuthn ceremonies through Chromium’s virtual authenticator. It covers:

- handle feedback and reserved names;
- the under-13 refusal;
- refusing an unverified passkey;
- signup, reload, sign-out and passkey sign-in;
- a duplicate @name on a second phone;
- a protected teen account;
- deletion, including the old passkey no longer working.

`tests/accounts-server.test.js` unit-tests the server’s verification rule.

## Before a public launch

- A privacy policy and terms page. Google Play requires a privacy policy, plus in-app and web account deletion; deletion is done.
- Report and block, and a way to review reports. Play requires these for apps with user-generated content.
- Email as an optional recovery route (Better Auth email-code plugin plus an email provider such as Resend).
- Linking each phone’s Real Seal key to the account, so loops show “Signed by @name”.
