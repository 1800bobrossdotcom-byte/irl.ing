// End-to-end check of friends, invites, blocks, loop sharing, reports and the
// review queue: real Better Auth server, real Postgres, real passkeys through
// Chromium's virtual authenticator, loops stored on disk the way R2 holds
// them, and the stub reviewer (the Claude reviewer is unit-tested with a fake
// client in moderation.test.js).
//
//   DATABASE_URL=postgres://... BETTER_AUTH_SECRET=... npm run db:migrate
//   npm run build && DATABASE_URL=... BETTER_AUTH_SECRET=... node tests/social-browser.mjs
//
// It starts its own server (port 3005, or SOCIAL_PORT) with sharing switched on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildLoop } from "../src/loops/container.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const port = Number(process.env.SOCIAL_PORT ?? 3005);
const base = `http://localhost:${port}`;
const unique = Date.now().toString(36).slice(-5);
const handles = { sun: `sun.${unique}`, moon: `moon.${unique}`, tide: `tide.${unique}`, star: `star.${unique}`, rev: `rev.${unique}` };
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const storageDir = await mkdtemp(join(tmpdir(), "irl-social-"));

// Each run starts with fresh rate-limit counters (they live in the database).
await db.query("delete from irl_rate_limit");

const env = { ...process.env, PORT: String(port), BETTER_AUTH_URL: base, LOCAL_STORAGE_DIR: storageDir, MODERATION_JUDGE: "stub", ADMIN_HANDLES: `@${handles.rev}` };
for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "ANTHROPIC_API_KEY"]) delete env[name];
const server = spawn(process.execPath, ["scripts/serve-local.mjs"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("irl.ing local") && resolve());
  server.on("exit", (code) => reject(new Error(`server exited (${code})`)));
});

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

const waitText = (page, id, re) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ""), [id, re.source], { timeout: 20_000 });

/** A fresh phone with its own passkey, signed up through the real screens. */
async function person(handle, { birthYear = 1994 } = {}) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(`${base}/loops/`, { waitUntil: "networkidle" });
  await waitText(page, "#account-open", /^Claim your @name$/);
  await page.locator("#account-open").click();
  await page.locator("#handle").fill(handle);
  await page.locator("#birth-month").selectOption("3");
  await page.locator("#birth-year").selectOption(String(birthYear));
  await page.locator("#accept-rules").check();
  await page.locator("#claim-continue").click();
  await waitText(page, "#save-handle", new RegExp(`@${handle.replace(".", "\\.")}`));
  await page.locator("#save-passkey").click();
  await waitText(page, "#done-handle", new RegExp(`^@${handle.replace(".", "\\.")}$`));
  await page.locator("#done-close").click();

  /** Call the API from this phone, with its session cookie. */
  const api = (path, body) =>
    page.evaluate(
      async ([path, body]) => {
        const r = await fetch(`/api/auth${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      [path, body],
    );
  /** Three JPEG still frames, made the way the app will make them: a canvas. */
  const stills = (hue) =>
    page.evaluate(async (hue) => {
      const out = [];
      for (let n = 0; n < 3; n++) {
        const canvas = new OffscreenCanvas(96, 96);
        const g = canvas.getContext("2d");
        g.fillStyle = `hsl(${hue + n * 40} 70% 50%)`;
        g.fillRect(0, 0, 96, 96);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })).arrayBuffer());
        out.push(btoa(String.fromCharCode(...bytes)));
      }
      return out;
    }, hue);
  const share = async (loop, thumbs) => api("/irl/loops/share", { loop: Buffer.from(loop).toString("base64"), thumbs: thumbs ?? (await stills(loop[100])) });
  return { handle, context, page, errors, api, share };
}

/** A signed loop of `seconds` at 30 fps. Different seeds give different loops (and IDs). */
const deviceKey = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
async function makeLoop(seed, { seconds = 6, keyPair = deviceKey } = {}) {
  const fps = 30;
  const frameCount = seconds * fps;
  const frames = Array.from({ length: frameCount }, (_, i) => ({
    timestamp: Math.round((i * 1e6) / fps),
    key: i % 60 === 0,
    layer: 0,
    data: Uint8Array.from({ length: 180 }, (_, j) => (seed * 97 + i * 31 + j * 7) & 0xff),
  }));
  const meta = { v: 2, codec: "av01.0.04M.08", width: 360, height: 360, fps, frameCount, gopFrames: 60, layers: 1 };
  return buildLoop({ meta, frames, gopFrames: 60, keyPair });
}

const feedIds = async (p) => ((await p.api("/irl/feed")).body?.loops ?? []).map((l) => l.id);
const stored = (id) => existsSync(join(storageDir, "loops", `${id}.irl`));
const loopRow = async (id) => (await db.query(`select * from irl_loop where "id" = $1`, [id])).rows[0] ?? null;

try {
  const sun = await person(handles.sun);
  const moon = await person(handles.moon);
  const tide = await person(handles.tide, { birthYear: new Date().getFullYear() - 15 });
  const star = await person(handles.star);
  const rev = await person(handles.rev);
  assert.equal((await sun.api("/irl/config")).body.sharing, true);

  // ---- friends by @name: a request, then the other side accepts --------------
  assert.deepEqual((await sun.api("/irl/friends/request", { handle: `@${handles.moon}` })).body, { status: "requested" });
  assert.deepEqual((await moon.api("/irl/friends")).body.incoming, [{ handle: handles.sun, name: handles.sun }]);
  assert.deepEqual((await sun.api("/irl/friends")).body.outgoing.map((f) => f.handle), [handles.moon]);
  assert.deepEqual((await moon.api("/irl/friends/respond", { handle: handles.sun, accept: true })).body, { status: "friends" });
  assert.deepEqual((await sun.api("/irl/friends")).body.friends.map((f) => f.handle), [handles.moon]);

  // ---- a teen can't be found by @name; the answer is the same as for no one --
  const teenAsk = await sun.api("/irl/friends/request", { handle: handles.tide });
  const nobody = await sun.api("/irl/friends/request", { handle: `nobody.${unique}` });
  assert.equal(teenAsk.status, 404);
  assert.deepEqual(teenAsk, nobody, "a teen account is indistinguishable from no account");
  assert.equal((await tide.api("/irl/me")).body.discoverable, false);

  // ---- ...but can share an invite link with someone they know -----------------
  const invite = (await tide.api("/irl/invites", {})).body;
  assert.match(invite.url, new RegExp(`^${base}/i/[A-Za-z0-9_-]{12}$`));
  const lookup = await sun.page.evaluate((code) => fetch(`/api/auth/irl/invite?code=${code}`).then((r) => r.json()), invite.code);
  assert.deepEqual(lookup, { inviter: { handle: handles.tide, name: handles.tide } });
  assert.equal((await sun.api("/irl/invites/accept", { code: invite.code })).body.status, "friends");
  assert.equal((await tide.api("/irl/invites/accept", { code: invite.code })).status, 400, "not your own invite");
  assert.deepEqual((await tide.api("/irl/friends")).body.friends.map((f) => f.handle), [handles.sun]);
  assert.equal((await sun.api("/irl/invites/accept", { code: "not-a-real-code" })).status, 404);

  // ---- blocks win over requests and invites, and look like nothing -----------
  await star.api("/irl/friends/request", { handle: handles.sun });
  assert.equal((await sun.api("/irl/friends")).body.incoming.length, 1);
  assert.deepEqual((await sun.api("/irl/block", { handle: handles.star })).body, { status: "blocked" });
  assert.deepEqual((await sun.api("/irl/block", { handle: `nobody.${unique}` })).body, { status: "blocked" }, "no probing for accounts");
  assert.equal((await sun.api("/irl/friends")).body.incoming.length, 0, "the pending request is gone");
  assert.deepEqual(await star.api("/irl/friends/request", { handle: handles.sun }), nobody);
  const sunInvite = (await sun.api("/irl/invites", {})).body;
  assert.equal((await star.api("/irl/invites/accept", { code: sunInvite.code })).status, 404);
  assert.deepEqual((await sun.api("/irl/blocks")).body.blocked.map((b) => b.handle), [handles.star], "you can see who you blocked");
  assert.deepEqual((await star.api("/irl/blocks")).body.blocked, [], "and only you");
  await sun.api("/irl/unblock", { handle: handles.star });
  assert.deepEqual((await sun.api("/irl/blocks")).body.blocked, []);
  await sun.api("/irl/block", { handle: handles.star }); // blocked again for the rest of the run
  // An invite used by someone who's already a friend keeps its uses.
  await moon.api("/irl/invites/accept", { code: sunInvite.code });
  await moon.api("/irl/invites/accept", { code: sunInvite.code });
  assert.equal((await db.query(`select "uses" from irl_invite where "code" = $1`, [sunInvite.code])).rows[0].uses, 0, "already friends: no use counted");

  // ---- sharing: only complete, sealed, six-second loops with stills ----------
  const first = await makeLoop(1);
  const shared = await sun.share(first);
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.equal(shared.body.status, "visible");
  assert.equal(shared.body.message, "Shared with your friends.");
  const id = shared.body.id;
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.ok(stored(id));
  assert.equal((await loopRow(id)).ownerTeen, false);

  const unsigned = await sun.share(await makeLoop(2, { keyPair: null }));
  assert.deepEqual([unsigned.status, unsigned.body.message], [400, "This loop’s Real Seal didn’t check out, so it can’t be shared."]);
  const tampered = (await makeLoop(3)).slice();
  tampered[tampered.length - 50] ^= 0x01; // one bit inside the last video chunk
  assert.equal((await sun.share(tampered)).body.message, "This loop’s Real Seal didn’t check out, so it can’t be shared.");
  assert.equal((await sun.share(await makeLoop(4, { seconds: 8 }))).body.message, "Loops are six seconds at most.");
  const notJpeg = Buffer.from("not a jpeg").toString("base64");
  assert.equal((await sun.share(await makeLoop(5), [notJpeg, notJpeg, notJpeg])).body.message, "The loop’s still frames are missing. Try sharing it again.");
  assert.equal((await sun.share(first)).body.message, "You already shared this loop.");
  assert.equal((await moon.share(first)).status, 409, "someone else's loop can't be re-shared as yours");
  const tooBig = await sun.page.evaluate(() => fetch("/api/auth/irl/loops/share", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(3 * 1024 * 1024) }).then((r) => r.status));
  assert.equal(tooBig, 413);
  const { rows: rejected } = await db.query(`select count(*)::int as n from irl_moderation_event e join "irl_user" u on u."id" = e."userId" where u."handle" = $1 and e."action" = 'rejected'`, [handles.sun]);
  assert.equal(rejected[0].n, 4, "every rejection is in the audit trail");

  // ---- the feed: friends and yourself, never strangers or blocked people -----
  assert.deepEqual(await feedIds(sun), [id]);
  assert.deepEqual(await feedIds(moon), [id]);
  assert.deepEqual(await feedIds(tide), [id]);
  assert.deepEqual(await feedIds(star), []);
  assert.deepEqual(await feedIds(rev), []);
  const moonFeed = (await moon.api("/irl/feed")).body;
  assert.equal(moonFeed.caughtUp, true);
  assert.deepEqual([moonFeed.loops[0].handle, moonFeed.loops[0].mine], [handles.sun, false]);
  // Playback goes straight to storage through a signed, expiring link.
  const played = await moon.page.evaluate((url) => fetch(url).then(async (r) => [r.status, (await r.arrayBuffer()).byteLength]), moonFeed.loops[0].loopUrl);
  assert.deepEqual(played, [200, first.length]);
  const forged = moonFeed.loops[0].loopUrl.replace(/sig=[0-9a-f]/, (m) => (m.endsWith("0") ? "sig=1" : "sig=0"));
  assert.equal(await moon.page.evaluate((url) => fetch(url).then((r) => r.status), forged), 403);
  const poster = await moon.page.evaluate((url) => fetch(url).then((r) => r.headers.get("content-type")), moonFeed.loops[0].posterUrl);
  assert.equal(poster, "image/jpeg");

  // ---- reports: three hide a loop, one child-safety report hides it at once --
  assert.equal((await sun.api("/irl/report", { id, reason: "other" })).status, 404, "not your own loop");
  assert.equal((await star.api("/irl/report", { id, reason: "other" })).status, 404, "only people who can see it");
  assert.equal((await moon.api("/irl/report", { id, reason: "harassment", note: "test" })).body.status, "reported");
  assert.deepEqual(await feedIds(moon), [id], "one report doesn't hide a loop");
  await tide.api("/irl/report", { id, reason: "child_safety" });
  assert.equal((await loopRow(id)).status, "held");
  assert.deepEqual(await feedIds(moon), []);
  assert.deepEqual((await sun.api("/irl/loops/mine")).body.loops.map((l) => [l.id, l.status]), [[id, "held"]]);

  // ---- review: reviewers only; a person restores or removes ------------------
  assert.equal((await moon.api("/irl/admin/queue")).status, 403);
  const queue = (await rev.api("/irl/admin/queue")).body.items;
  const item = queue.find((q) => q.id === id);
  assert.deepEqual(item.reports.map((r) => r.reason).sort(), ["child_safety", "harassment"]);
  assert.equal(item.frames.length, 3);
  assert.equal(await rev.page.evaluate((url) => fetch(url).then((r) => r.status), item.frames[1]), 200);
  assert.equal((await moon.api("/irl/admin/decide", { id, action: "restore" })).status, 403);
  assert.deepEqual((await rev.api("/irl/admin/decide", { id, action: "restore", note: "a joke between friends" })).body, { status: "visible" });
  assert.deepEqual(await feedIds(moon), [id]);
  assert.equal((await rev.api("/irl/admin/queue")).body.items.some((q) => q.id === id), false, "its reports are resolved");

  // ---- strikes: three removals pause posting; escalations are preserved -----
  const more = [];
  for (const seed of [10, 11, 12]) more.push((await sun.share(await makeLoop(seed))).body.id);
  assert.deepEqual((await sun.api("/irl/loops/mine")).body.loops.length, 4);
  await rev.api("/irl/admin/decide", { id: more[0], action: "remove_strike" });
  await rev.api("/irl/admin/decide", { id: more[1], action: "remove_strike" });
  assert.equal((await sun.share(await makeLoop(13))).status, 200, "two strikes: still posting");
  assert.deepEqual((await rev.api("/irl/admin/decide", { id: more[2], action: "escalate" })).body, { status: "held" });
  const escalated = (await rev.api("/irl/admin/queue")).body.items.find((q) => q.id === more[2]);
  assert.deepEqual([escalated.escalated, escalated.frames, escalated.loopUrl], [true, null, null], "escalations are never previewed");
  assert.equal((await rev.api("/irl/admin/decide", { id: more[2], action: "restore" })).status, 409);
  const paused = await sun.share(await makeLoop(14));
  assert.deepEqual([paused.status, paused.body.message], [403, "Posting is paused on this account after repeated rule breaks."]);
  assert.equal((await moon.share(await makeLoop(15))).status, 200, "others still post");
  assert.ok(!(await feedIds(moon)).includes(more[0]), "removed loops leave the feed");

  // ---- deleting: your loops go with you, except what the law says to keep ----
  assert.deepEqual((await sun.api("/irl/loops/delete", { id: more[2] })).body, { status: "deleted" });
  assert.equal((await loopRow(more[2])).status, "removed");
  assert.ok(stored(more[2]), "an escalated loop is preserved even when its owner deletes it");
  assert.deepEqual((await moon.api("/irl/loops/delete", { id })).status, 404, "only your own loops");
  await sun.page.locator("#account-open").click();
  await sun.page.locator("details.danger summary").click();
  await sun.page.locator("#delete-confirm").fill(`@${handles.sun}`);
  await sun.page.locator("#delete-account").click();
  await waitText(sun.page, "#account-open", /^Claim your @name$/);
  assert.equal(await loopRow(id), null);
  assert.equal(stored(id), false, "the loop file is gone");
  assert.equal(stored(more[0]), false);
  assert.equal((await loopRow(more[2])).owner, null, "the preserved loop no longer points at an account");
  assert.ok(stored(more[2]));
  assert.deepEqual((await moon.api("/irl/friends")).body.friends, [], "and the friendship is gone");
  assert.deepEqual(await feedIds(moon), [(await moon.api("/irl/loops/mine")).body.loops[0].id]);

  for (const p of [sun, moon, tide, star, rev]) assert.deepEqual(p.errors, [], p.handle);
  console.log(`social ok: friends, teen protection, invites, blocks, 4 rejected shares, feed, signed playback, reports, review, strikes, escalation, deletion`);
} finally {
  await browser.close();
  server.kill();
  await db.end();
  await rm(storageDir, { recursive: true, force: true });
}
