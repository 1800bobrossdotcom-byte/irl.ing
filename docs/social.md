# Friends, loops and safety review: the backend

This covers the server side of friends, invites, blocks, sharing loops, the feed, reports and human review. It runs in the same Vercel function as [accounts](accounts.md) (`/api/auth/*`), as a Better Auth plugin, so it shares sessions, origin checks and database-backed rate limits.

**Status:** built and tested end to end on this branch. It isn't switched on anywhere yet, and the app screens for it come with the redesign. The safety program it implements is in [user safety](user-safety.md).

## How it fits together

```
phone ──POST /irl/loops/share (loop + 3 stills)──▶ irl.ing server
                                                    1. verify: complete, Real Seal valid, ≤ 6 s, JPEG stills
                                                    2. Claude reviews the 3 stills against the community rules
                                                    3. irl.ing's policy decides: show / hold / block
                                                    4. store privately in R2, record the decision
friend ──GET /irl/feed──▶ server ──▶ signed, expiring R2 links ──▶ friend's phone plays straight from R2
```

- **Uploads go through the server, not straight to R2.** R2 has no way to cap the size of a signed upload link (it doesn't support POST policies, and the signing library can't sign `Content-Length`), so a signed link would let any account push gigabytes into the bucket. A shared loop is at most 512 KB plus three ~20 KB stills, which fits easily in one request. In return, nothing reaches storage until it has been verified.
- **Playback goes straight to R2** through signed GET links that expire in 10 minutes and are issued one loop at a time, only to the owner and accepted friends.
- **A loop's ID is its Real Seal ID**, the SHA-256 of its signed manifest. The same loop can only be shared once, and nobody can re-share a friend's loop as their own.

## Endpoints

All live under `/api/auth`. Everything except the invite lookup needs a session.

| Endpoint | What it does |
| --- | --- |
| `GET /irl/config` | Adds `sharing: true` once storage and the reviewer are configured. |
| `GET /irl/friends` | Your friends, incoming requests and outgoing requests. |
| `POST /irl/friends/request {handle}` | Sends a request by exact @name. If they already asked you, you're friends. Teens, people who switched discovery off, blocked people and nonexistent names all get the same answer: "No one by that @name." |
| `POST /irl/friends/respond {handle, accept}` | Accepts or declines a request. |
| `POST /irl/friends/remove {handle}` | Ends a friendship. |
| `POST /irl/block {handle}` / `POST /irl/unblock {handle}` | Blocking ends any friendship or request and stops new ones. The answer is the same whether or not the account exists. |
| `POST /irl/invites` | Makes an invite: `{code, url: https://irl.ing/i/<code>, expiresAt}`. It lasts 30 days and can be used 25 times. The QR code is drawn on the phone from the URL. |
| `GET /irl/invite?code=` | Public: who sent this invite. Used on the invite page before signup. |
| `POST /irl/invites/accept {code}` | You and the inviter become friends. This is how adults and teens connect: only through a code the other person chose to share. |
| `POST /irl/loops/share {loop, thumbs[3]}` | Base64 `.irl` file and three JPEG stills. Returns `{id, status: visible\|held\|removed, message, supportResources}`. |
| `GET /irl/feed` | Visible loops from the last 30 days from friends and yourself, newest first, with signed `loopUrl` and `posterUrl`. Ends with `caughtUp: true`. |
| `GET /irl/loops/mine` | Your loops, including ones held for a person to check. |
| `POST /irl/loops/delete {id}` | Deletes your loop and its files. Child-safety escalations are only hidden, never deleted (the law requires preserving them). |
| `POST /irl/report {id, reason, note?}` | Reasons: `child_safety`, `sexual`, `violence`, `self_harm`, `hate`, `harassment`, `privacy`, `scam`, `other`. Only people who can see the loop can report it. A child-safety report, or three open reports, hides it at once. |
| `GET /irl/admin/queue` | Reviewers only: held and reported loops with their AI verdict, reports, stills and a playback link. Escalations are listed with no previews. |
| `POST /irl/admin/decide {id, action, note?}` | Reviewers only. `restore`, `remove`, `remove_strike` (remove and add a strike) or `escalate` (child safety: hide, preserve, add a strike). Escalations can't be restored here. Resolves the loop's reports. |

Deleting an account also deletes its loops and their files, except escalations, which stay with the owner cleared.

## Rules the server enforces

- **Sharing:** the loop must be complete (no damaged or missing chunks), carry a valid Real Seal covering every chunk with none added, last at most 6.5 seconds, and come with three JPEG stills. Bodies over 2 MB are refused before they're read. Limits: 30 loops a day and 20 share requests per 10 minutes.
- **Safety review:** see [`src/server/moderation.js`](../src/server/moderation.js) and the outcome table in [user safety](user-safety.md).
  - Claude returns a strict JSON verdict, and irl.ing's own policy table decides the outcome.
  - The review is bounded: a 25-second timeout and one retry. A review that times out, errors, is refused or returns something unreadable holds the loop.
  - The share request stays inside the function's 60-second limit.
- **Strikes:** a blocked loop, a reviewer's "remove and strike" or an escalation each add a strike. Three strikes pause posting.
- **Audit:** every rejection, AI decision, report, reviewer action, escalation and suspension is written to `irl_moderation_event`.
- **Rate limits** (per IP, stored in Postgres):

  | Action | Limit |
  | --- | --- |
  | Friend requests | 30 per 10 minutes |
  | Invites | 20 per hour |
  | Invite lookups | 20 per minute |
  | Accepting invites | 20 per 10 minutes |
  | Blocks | 30 per 10 minutes |
  | Shares | 20 per 10 minutes |
  | Reports | 20 per 10 minutes |

## Tables

`db/social.sql`, applied by `npm run db:migrate` after Better Auth's tables (safe to re-run):

| Table | Contents |
| --- | --- |
| `irl_friendship` | One row per pair (smaller id first): pending or accepted, and who asked. |
| `irl_block` | Who blocked whom. |
| `irl_invite` | Code, inviter, expiry, uses. |
| `irl_loop` | Seal ID, owner, status, size, seal key, whether the owner was a teen, the AI verdict, escalation flag. |
| `irl_seal_key` | Device keys that have sealed loops for an account (trust on first use). |
| `irl_report` | Reports and how they were resolved. |
| `irl_moderation_event` | The audit trail. |
| `irl_strike` | Strikes; `irl_user.suspendedAt` is set at three. |

## Switching it on

> **Switch it on for Preview first.** Hosting other people's photos and video brings legal duties, above all reporting child sexual abuse material to NCMEC. Keep sharing to Preview deployments and people you know until the "Before a public launch" list in [user safety](user-safety.md) is done.

1. **R2 bucket.** In Cloudflare: R2 → Create bucket (for example `irl-loops`). Leave public access off.
2. **R2 token.** R2 → Manage API tokens → Create API token, with *Object Read & Write* on that bucket only. Keep the Access Key ID and Secret Access Key. The Account ID is on the R2 overview page.
3. **CORS.** In the bucket's Settings → CORS policy, allow playback from the site:
   ```json
   [{ "AllowedOrigins": ["https://irl.ing"], "AllowedMethods": ["GET"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
   ```
   Add a preview's URL to `AllowedOrigins` while testing on it.
4. **Reviewer.** Create an API key in the Anthropic Console.
5. **Vercel environment variables.** Add these as Sensitive, for Preview to start:

   | Variable | Value |
   | --- | --- |
   | `R2_ACCOUNT_ID` | The Account ID |
   | `R2_ACCESS_KEY_ID` | The token's Access Key ID |
   | `R2_SECRET_ACCESS_KEY` | The token's Secret Access Key |
   | `R2_BUCKET` | The bucket name |
   | `ANTHROPIC_API_KEY` | The Anthropic key |
   | `ADMIN_HANDLES` | Comma-separated @names of reviewers |
   | `MODERATION_MODEL` | Optional; overrides the default reviewer model |

6. **Tables.** Run `npm run db:migrate` with the Neon connection string, or paste `db/social.sql` into Neon's SQL editor.
7. **Redeploy.** `/api/auth/irl/config` then reports `sharing: true`.

### If it doesn't switch on

Previews sit behind Vercel's login, so open `<preview URL>/api/auth/irl/config` in a browser signed in to Vercel.

| It shows | Meaning and fix |
| --- | --- |
| `"sharing": false, "sharingMissing": [...]` | Those variables aren't reaching this deployment. Check each name for typos, that **Preview** is ticked, and that it isn't limited to another Git branch. Variable changes apply to the next deployment. Production never lists names. |
| `"code": "SCHEMA_MISMATCH", "missing": [...]` | The database lacks those tables. Neon's Vercel integration gives each Git branch its own copy of the database, made the first time that branch is previewed. Preview builds run `db:migrate --if-preview`, which adds what's missing, so redeploying fixes it. For production, run `npm run db:migrate` or paste the SQL. |
| `"code": "ENOTFOUND"`, `"ECONNREFUSED"` or `"ETIMEDOUT"` | The deployment can't reach Postgres. Check the database variables for this environment. |
| Vercel's own "This page is unavailable" | The function failed before irl.ing's code ran. The deployment's **Logs** tab has the error. |

## Running and testing locally

Local runs keep loops in a directory instead of R2, with HMAC-signed, expiring links served at `/api/dev-storage/*`. They use a stub reviewer that allows everything. Neither can run in production: both refuse when `VERCEL_ENV=production`.

```sh
export DATABASE_URL=postgres://postgres@localhost:5433/irling BETTER_AUTH_SECRET=dev-secret-at-least-32-characters-long
npm run db:migrate && npm run build
node tests/social-browser.mjs      # starts its own server on :3005 (or SOCIAL_PORT) with sharing on
npm test                           # unit tests, including the Claude reviewer against a fake client
```

`tests/social-browser.mjs` signs up five people with real passkeys (one a 15-year-old) and runs the whole system. It covers:

- **Friends:** requests, teen protection, invites and blocks.
- **Sharing:** four kinds of rejected share, plus signed playback.
- **Safety:** reports, review, strikes, escalation, and deletion, checked in both the database and storage.
