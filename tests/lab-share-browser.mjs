// "Share with friends" from the loops lab, end to end: two people with real
// passkeys become friends through a real invite link made in the account
// sheet; one records a loop with the (fake) camera and shares it from the
// lab; it arrives in the other's feed. The sample can't be shared, and
// signed out the button asks you to sign in.
//
//   npm run build && DATABASE_URL=... BETTER_AUTH_SECRET=... node tests/lab-share-browser.mjs
//
// It starts its own server (port 3013, or LAB_SHARE_PORT) with sharing on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const { chromium } = createRequire(import.meta.url)("playwright");
const port = Number(process.env.LAB_SHARE_PORT ?? 3013);
const base = `http://localhost:${port}`;
const unique = Date.now().toString(36).slice(-5);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const storageDir = await mkdtemp(join(tmpdir(), "irl-lab-share-"));
await db.query("delete from irl_rate_limit");

const env = { ...process.env, PORT: String(port), BETTER_AUTH_URL: base, LOCAL_STORAGE_DIR: storageDir, MODERATION_JUDGE: "stub" };
for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "ANTHROPIC_API_KEY"]) delete env[name];
const server = spawn(process.execPath, ["scripts/serve-local.mjs"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("irl.ing local") && resolve());
  server.on("exit", (code) => reject(new Error(`server exited (${code})`)));
});

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH && { executablePath: process.env.CHROMIUM_PATH }),
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const waitText = (page, sel, re) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ""), [sel, re.source], { timeout: 60_000 });
const visible = (page, sel) => page.locator(sel).isVisible();

async function phone({ signUp }) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(`${base}/loops/`, { waitUntil: "networkidle" });
  if (signUp) {
    await waitText(page, "#account-open", /^Claim your @name$/);
    await page.locator("#account-open").click();
    await page.locator("#handle").fill(signUp);
    await page.locator("#birth-month").selectOption("3");
    await page.locator("#birth-year").selectOption("1994");
    await page.locator("#accept-rules").check();
    await page.locator("#claim-continue").click();
    await page.locator("#save-passkey").click();
    await waitText(page, "#done-handle", new RegExp(`^@${signUp.replace(".", "\\.")}$`));
  }
  const api = (path, body) =>
    page.evaluate(
      async ([path, body]) => {
        const r = await fetch(`/api/auth${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      [path, body],
    );
  return { page, errors, api };
}

async function record(page) {
  await page.locator("#camera-on").click();
  await page.waitForFunction(() => document.querySelector("#live").videoWidth > 0, null, { timeout: 30_000 });
  const box = await page.locator("#record").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => !document.querySelector("#build").hidden && document.querySelector("#quality").textContent.includes("dB"), null, { timeout: 90_000 });
  await page.mouse.up();
}

try {
  const maya = `maya.${unique}`;
  const jules = `jules.${unique}`;
  const a = await phone({ signUp: maya });

  // The account sheet's "Invite a friend" now makes a real invite link.
  await a.page.evaluate(() => {
    navigator.share = undefined;
    navigator.clipboard.writeText = async (t) => (window.__copied = t);
  });
  await a.page.locator("#invite").click();
  await a.page.waitForFunction(() => window.__copied, null, { timeout: 10_000 });
  const copied = await a.page.evaluate(() => window.__copied);
  const code = copied.match(/\/i\/([A-Za-z0-9_-]{12})/)?.[1];
  assert.ok(code, `the invite text carries a real invite link: ${copied}`);
  assert.equal(await a.page.locator("#done-feed").getAttribute("href"), "/friends/");
  await a.page.locator("#done-close").click();

  const b = await phone({ signUp: jules });
  assert.equal((await b.api("/irl/invites/accept", { code })).body.status, "friends");

  // The sample can't be shared.
  await a.page.locator("#try-sample").click();
  await a.page.waitForFunction(() => !document.querySelector("#build").hidden && document.querySelector("#quality").textContent.includes("dB"), null, { timeout: 90_000 });
  await a.page.waitForTimeout(500);
  assert.equal(await visible(a.page, "#share-friends"), false, "the sample isn't shareable");

  // A loop recorded here is.
  await a.page.locator("#again").click();
  assert.equal(await visible(a.page, "#share-friends"), false);
  await record(a.page);
  await a.page.locator("#share-friends").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await a.page.locator("#share-friends").textContent(), "Share with friends");
  await a.page.locator("#share-friends").click();
  await waitText(a.page, "#share-friends-note", /^Shared with your friends\. Open your feed$/);
  assert.equal(await a.page.locator("#share-friends-note a").getAttribute("href"), "/friends/");
  assert.equal(await visible(a.page, "#share-friends"), false, "one share per loop");

  const feed = (await b.api("/irl/feed")).body.loops;
  assert.equal(feed.length, 1);
  assert.equal(feed[0].handle, maya);
  const poster = await b.page.evaluate((url) => fetch(url).then((r) => r.headers.get("content-type")), feed[0].posterUrl);
  assert.equal(poster, "image/jpeg");
  const { rows } = await db.query(`select "status", "bytes" from irl_loop where "id" = $1`, [feed[0].id]);
  assert.equal(rows[0].status, "visible");
  assert.ok(rows[0].bytes > 10_000 && rows[0].bytes < 512 * 1024, `a real loop (${rows[0].bytes} bytes)`);

  // Signed out, the same button asks you to sign in.
  const c = await phone({ signUp: null });
  await record(c.page);
  await c.page.locator("#share-friends").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await c.page.locator("#share-friends").textContent(), "Sign in to share");
  await c.page.locator("#share-friends").click();
  assert.equal(await c.page.locator("#account-sheet").evaluate((d) => d.open), true, "it opens the account sheet");

  for (const p of [a, b, c]) assert.deepEqual(p.errors, []);
  console.log("lab share ok: real invite link from the account sheet, sample not shareable, recorded loop shared from the lab into a friend's feed, signed-out prompt");
} finally {
  await browser.close();
  server.kill();
  await db.end();
  await rm(storageDir, { recursive: true, force: true });
}
