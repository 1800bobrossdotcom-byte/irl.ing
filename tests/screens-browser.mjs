// End-to-end check of the social screens (/friends/, /i/<code>, /review/)
// and src/social/share.js, driven through the real pages: real Better Auth
// server, real Postgres, real passkeys through Chromium's virtual
// authenticator, a real loop encoded by the lab, loops stored on disk the way
// R2 holds them, and the stub reviewer.
//
//   DATABASE_URL=postgres://... BETTER_AUTH_SECRET=... npm run db:migrate
//   npm run build && DATABASE_URL=... BETTER_AUTH_SECRET=... node tests/screens-browser.mjs [screenshot-dir]
//
// It starts its own server (port 3012, or SCREENS_PORT) with sharing on. With
// a screenshot directory it saves every screen and state at 390 px and on
// desktop, light and dark, at 2x.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildLoop, parseLoop } from "../src/loops/container.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const port = Number(process.env.SCREENS_PORT ?? 3012);
const base = `http://localhost:${port}`;
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const unique = Date.now().toString(36).slice(-5);
const handles = { ana: `ana.${unique}`, ben: `ben.${unique}`, cy: `cy.${unique}`, dee: `dee.${unique}` };
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const storageDir = await mkdtemp(join(tmpdir(), "irl-screens-"));

await db.query("delete from irl_rate_limit"); // fresh counters for this run

const env = { ...process.env, PORT: String(port), BETTER_AUTH_URL: base, LOCAL_STORAGE_DIR: storageDir, MODERATION_JUDGE: "stub", ADMIN_HANDLES: `@${handles.cy}` };
for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "ANTHROPIC_API_KEY"]) delete env[name];
const server = spawn(process.execPath, ["scripts/serve-local.mjs"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("irl.ing local") && resolve());
  server.on("exit", (code) => reject(new Error(`server exited (${code})`)));
});

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const requested = []; // every URL any page asked for
const re = (handle) => handle.replace(/\./g, "\\.");
const waitText = (page, selector, pattern, timeout = 20_000) =>
  page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ""), [selector, pattern.source], { timeout });
const sheet = (page) => page.locator("dialog.sheet[open]");
const sheetButton = (page, name) => sheet(page).getByRole("button", { name, exact: true });
let snaps = 0;

/** A phone (390 × 844 at 2x) with its own virtual passkey authenticator. */
async function phone() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  context.on("request", (r) => requested.push(r.url()));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  /** Call the API from this phone, with its session cookie. */
  const api = (path, body) =>
    page.evaluate(
      async ([path, body]) => {
        const r = await fetch(`/api/auth${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      [path, body],
    );
  return { context, page, errors, api };
}

/** Claim an @name in the lab's sheet (the only sign-up screen today). */
async function claim(page, handle) {
  if (!new URL(page.url()).pathname.startsWith("/loops/")) await page.goto(`${base}/loops/`, { waitUntil: "networkidle" });
  await waitText(page, "#account-open", /^Claim your @name$/);
  await page.locator("#account-open").click();
  await page.locator("#handle").fill(handle);
  await page.locator("#birth-month").selectOption("3");
  await page.locator("#birth-year").selectOption("1994");
  await page.locator("#accept-rules").check();
  await page.locator("#claim-continue").click();
  await waitText(page, "#save-handle", new RegExp(`@${re(handle)}`));
  await page.locator("#save-passkey").click();
  await waitText(page, "#done-handle", new RegExp(`^@${re(handle)}$`));
  await page.locator("#done-close").click();
}

async function person(handle) {
  const p = await phone();
  await claim(p.page, handle);
  p.handle = handle;
  return p;
}

/**
 * Screenshots of the current state at 390 px and on desktop, light and dark.
 * Also checks nothing scrolls sideways at 360, 390 and 430 px or on desktop.
 * Open sheets are shot at screen size: a modal only covers the screen.
 */
async function snap(page, name, { fullPage = true } = {}) {
  for (const width of [360, 430, 1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(scroll <= inner, `${name}: scrolls sideways at ${width}px (${scroll} > ${inner})`);
  }
  if (!shots) return;
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [
      ["390", { width: 390, height: 844 }],
      ["desktop", { width: 1280, height: 800 }],
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${shots}/${name}-${label}-${scheme}.png`, fullPage });
      snaps++;
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
}

let visit = 0;
/** Open /friends/ afresh (a new query string, so it's never just a hash change). */
const openFriends = async (page, hash = "feed") => {
  await page.goto(`${base}/friends/?v=${++visit}#${hash}`, { waitUntil: "networkidle" });
  await page.locator(".tabs").waitFor();
  await page.waitForFunction((n) => {
    const panel = document.getElementById(`${n}-panel`);
    return !panel.hidden && !panel.hasAttribute("aria-busy") && panel.children.length > 0;
  }, hash);
};
const item = (page, id) => page.locator(`li[data-id="${id}"]`);
const posterLoaded = (page, id) =>
  page.waitForFunction((id) => {
    const img = document.querySelector(`li[data-id="${id}"] img`);
    return img?.complete && img.naturalWidth > 0;
  }, id);
const playing = (page, id) => item(page, id).locator('.frame[data-state="playing"]').waitFor({ timeout: 30_000 });
const canvasFrame = (page) => page.evaluate(() => document.querySelector(".loop-canvas").toDataURL());
const feedIds = (page) => page.locator("#feed-panel li.loop").evaluateAll((els) => els.map((el) => el.dataset.id));

/** A 440 Hz tone as 8-bit WAV, to give a loop some sound. */
function tone(seconds = 1, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return new Uint8Array(b);
}

/** The same encoded video, sealed by another device key (so a new loop ID), optionally with sound. */
async function reseal(bytes, audio = null) {
  const parsed = parseLoop(bytes);
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  return buildLoop({ meta: parsed.meta, frames: parsed.frames, gopFrames: parsed.meta.gopFrames, audio, keyPair });
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const shareSource = readFileSync(new URL("../src/social/share.js", import.meta.url), "utf8");
/** Load the real src/social/share.js into a page as window.irlShare. */
const loadShare = (page) =>
  page.evaluate(async (source) => {
    window.irlShare = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
  }, shareSource);
/** Share loop bytes from a page with share.js. */
async function shareFrom(page, bytes, stills) {
  await loadShare(page);
  return page.evaluate(([loop, stills]) => window.irlShare.shareLoop(Uint8Array.from(atob(loop), (c) => c.charCodeAt(0)), stills), [b64(bytes), stills]);
}

const people = [];
try {
  // ---- signed out ---------------------------------------------------------------------
  const guest = await phone();
  people.push(guest);
  await guest.page.goto(`${base}/friends/`, { waitUntil: "networkidle" });
  await guest.page.getByRole("button", { name: "Sign in" }).waitFor();
  assert.equal(await guest.page.getByRole("link", { name: "Make your @name" }).getAttribute("href"), "/loops/");
  await snap(guest.page, "01-friends-signed-out");

  const ana = await person(handles.ana);
  const ben = await person(handles.ben);
  const cy = await person(handles.cy);
  people.push(ana, ben, cy);

  // ---- invite link → accept → friends --------------------------------------------------
  await openFriends(ana.page, "friends");
  await ana.page.getByRole("button", { name: "Make an invite link" }).click();
  const inviteUrl = await ana.page.locator(".invite-url").inputValue();
  assert.match(inviteUrl, new RegExp(`^${base}/i/[A-Za-z0-9_-]{12}$`));
  const code = inviteUrl.split("/").pop();
  assert.ok((await ana.page.locator("svg.qr path").getAttribute("d")).length > 500, "the QR code is drawn");
  await ana.page.getByRole("button", { name: "Copy" }).click();
  await waitText(ana.page, "#invite-note", /^Copied\.$/);
  await snap(ana.page, "02-friends-invite");

  // Signed out on the invite page: the code is kept, and there are two ways in.
  await ben.api("/sign-out", {});
  await ben.page.goto(inviteUrl, { waitUntil: "networkidle" });
  await waitText(ben.page, "#title", new RegExp(`^@${re(handles.ana)} invited you\\.$`));
  assert.equal(await ben.page.getByRole("link", { name: "Make your @name" }).getAttribute("href"), `/loops/?invite=${code}`);
  assert.equal(await ben.page.evaluate(() => localStorage.getItem("irl.invite")), code);
  await snap(ben.page, "03-invite-signed-out");
  // Sign in with the passkey, which accepts the invite.
  await ben.page.getByRole("button", { name: "Sign in" }).click();
  await waitText(ben.page, "#title", new RegExp(`^You and @${re(handles.ana)} are friends\\.$`));
  assert.equal(await ben.page.getByRole("link", { name: "Open your feed" }).getAttribute("href"), "/friends/");
  assert.equal(await ben.page.evaluate(() => localStorage.getItem("irl.invite")), null);
  await snap(ben.page, "04-invite-accepted");

  // Signed in: one button.
  await cy.page.goto(inviteUrl, { waitUntil: "networkidle" });
  await cy.page.getByRole("button", { name: `Add @${handles.ana}` }).waitFor();
  await snap(cy.page, "05-invite-signed-in");
  await guest.page.goto(`${base}/i/notarealcode0`, { waitUntil: "networkidle" });
  await waitText(guest.page, "#title", /^This invite has expired\.$/);
  await snap(guest.page, "06-invite-expired");

  // Someone new: invite → make an @name → the invite is waiting on /friends/.
  await guest.page.goto(inviteUrl, { waitUntil: "networkidle" });
  await guest.page.getByRole("link", { name: "Make your @name" }).click();
  await guest.page.waitForURL(`${base}/loops/?invite=${code}`);
  await claim(guest.page, handles.dee);
  await guest.page.goto(`${base}/friends/`, { waitUntil: "networkidle" });
  const addAna = guest.page.getByRole("button", { name: `Add @${handles.ana}` });
  await addAna.waitFor();
  await snap(guest.page, "07-friends-invite-waiting");
  await addAna.click();
  await waitText(guest.page, "#toast", new RegExp(`You and @${re(handles.ana)} are friends\\.`));
  assert.equal(await guest.page.locator("#invite-notice").isHidden(), true);

  // ---- add by @name → accept ---------------------------------------------------------------
  await openFriends(cy.page, "friends");
  await cy.page.locator("#add-handle").fill(`nobody.${unique}`);
  await cy.page.getByRole("button", { name: "Add", exact: true }).click();
  await waitText(cy.page, "#add-note", /^No one by that @name\.$/);
  await cy.page.locator("#add-handle").fill(`@${handles.ana}`);
  await cy.page.getByRole("button", { name: "Add", exact: true }).click();
  await waitText(cy.page, "#add-note", new RegExp(`^Request sent to @${re(handles.ana)}\\.$`));
  await cy.page.locator(".rows .row", { hasText: `@${handles.ana}` }).getByText("Pending").waitFor();
  await snap(cy.page, "08-friends-pending");

  await openFriends(ana.page, "friends");
  await waitText(ana.page, "#badge", /^1 request$/);
  await snap(ana.page, "09-friends-requests");
  await ana.page.getByRole("button", { name: `Accept @${handles.cy}` }).click();
  await waitText(ana.page, "#toast", new RegExp(`You and @${re(handles.cy)} are friends\\.`));
  await ana.page.locator("#friends-panel .row", { hasText: `@${handles.cy}` }).locator(".more").waitFor();
  assert.equal(await ana.page.locator("#badge").isHidden(), true);
  assert.deepEqual((await ana.api("/irl/friends")).body.friends.map((f) => f.handle).sort(), [handles.ben, handles.cy, handles.dee].sort());

  // A request declined.
  await ben.api("/irl/friends/request", { handle: handles.cy });
  await openFriends(cy.page, "friends");
  await cy.page.getByRole("button", { name: `Decline @${handles.ben}` }).click();
  await waitText(cy.page, "#toast", /^Declined\.$/);
  assert.deepEqual((await ben.api("/irl/friends")).body.outgoing, []);

  // ---- a real loop: encoded by the lab, stills and sharing by share.js -------------------------
  await ana.page.goto(`${base}/loops/`, { waitUntil: "networkidle" });
  await ana.page.locator("#try-sample").click();
  await ana.page.waitForFunction(() => document.querySelector("#quality").textContent.includes("dB"), null, { timeout: 120_000 });
  const [download] = await Promise.all([ana.page.waitForEvent("download"), ana.page.locator("#download").click()]);
  const labLoop = new Uint8Array(readFileSync(await download.path()));
  assert.equal(parseLoop(labLoop).meta.codecName, "AV1");
  await loadShare(ana.page);
  const made = await ana.page.evaluate(async (loop) => {
    const { makeStills, shareLoop } = window.irlShare;
    const decode = async (still) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${still}`;
      await img.decode();
      const bytes = atob(still);
      return { width: img.naturalWidth, bytes: bytes.length, jpeg: bytes.charCodeAt(0) === 0xff && bytes.charCodeAt(1) === 0xd8 };
    };
    // Frames off the lab's player canvas, a second or so apart.
    const frames = [];
    for (const wait of [2600, 1500, 1500]) { // after the smart pixels assemble
      await new Promise((r) => setTimeout(r, wait));
      frames.push(await createImageBitmap(document.getElementById("player")));
    }
    const stills = await makeStills(frames);
    // The recorder's clip: square I420 frames.
    const size = 64;
    const i420 = (y) => Uint8Array.from({ length: size * size * 1.5 }, (_, i) => (i < size * size ? y : 128));
    const clip = await makeStills({ frames: [i420(40), i420(120), i420(200), i420(235)], size });
    // A big, noisy picture still comes in under 160 KB.
    const big = Object.assign(document.createElement("canvas"), { width: 2400, height: 2400 });
    const g = big.getContext("2d");
    const noise = g.createImageData(2400, 2400);
    for (let i = 0; i < noise.data.length; i++) noise.data[i] = (i & 3) === 3 ? 255 : Math.random() * 256;
    g.putImageData(noise, 0, 0);
    const bytes = Uint8Array.from(atob(loop), (c) => c.charCodeAt(0));
    return {
      raw: stills,
      stills: await Promise.all(stills.map(decode)),
      clip: await Promise.all(clip.map(decode)),
      clipDistinct: new Set(clip).size,
      big: await Promise.all((await makeStills(big)).map(decode)),
      shared: await shareLoop(bytes, stills),
      again: await shareLoop(bytes, stills),
      junk: await shareLoop(new Uint8Array([1, 2, 3, 4]), stills),
    };
  }, b64(labLoop));
  for (const s of [...made.stills, ...made.clip, ...made.big]) assert.ok(s.jpeg && s.bytes <= 160 * 1024 && s.width > 0, JSON.stringify(s));
  assert.ok(made.stills[0].width >= 360 && made.stills[0].width <= 720, "player frames are kept, at 720 px at most");
  assert.equal(made.clip[0].width, 64);
  assert.equal(made.clipDistinct, 3, "start, middle and end are different frames");
  assert.ok(made.big[0].width <= 720);
  assert.deepEqual([made.shared.status, made.shared.message, made.shared.supportResources], ["visible", "Shared with your friends.", false]);
  const L1 = made.shared.id;
  assert.equal(made.again.message, "You already shared this loop.");
  assert.deepEqual([made.junk.status, made.junk.message], ["error", "That isn’t a loop irl.ing can share."], "the server's message comes back");

  // Ben's loop: the same video, sealed on his phone, with sound. Ana's second loop, for review.
  const withSound = await shareFrom(ben.page, await reseal(labLoop, { mime: "audio/wav", data: tone() }), made.raw);
  assert.equal(withSound.status, "visible", JSON.stringify(withSound));
  const L2 = withSound.id;
  const L3 = (await shareFrom(ana.page, await reseal(labLoop), made.raw)).id;
  assert.ok(L3 && L3 !== L1);

  // ---- the feed: posters, playback, and a fresh link when one has expired ---------------------
  await openFriends(ben.page);
  await posterLoaded(ben.page, L1);
  await posterLoaded(ben.page, L2);
  assert.deepEqual((await feedIds(ben.page)).sort(), [L1, L2, L3].sort());
  await waitText(ben.page, "#feed-panel .end", /^You’re caught up\.$/);
  await snap(ben.page, "10-feed");

  // The first fetch of the loop is refused, as an expired link would be: the feed is refetched and it plays.
  let refused = 0;
  let feedFetches = 0;
  ben.page.on("request", (r) => r.url().includes("/api/auth/irl/feed") && feedFetches++);
  await ben.page.route("**/api/dev-storage/loops/**", (route) => (refused++ === 0 ? route.fulfill({ status: 403, body: "expired" }) : route.continue()));
  await item(ben.page, L1).locator(".frame").click();
  await playing(ben.page, L1);
  assert.equal(feedFetches, 1, "an expired link fetches the feed again");
  assert.equal(refused, 2, "and the loop is fetched again with the new link");
  await ben.page.unroute("**/api/dev-storage/loops/**");
  assert.equal(await item(ben.page, L1).locator(".frame").getAttribute("aria-pressed"), "true");
  await ben.page.waitForTimeout(2600); // the smart pixels have assembled
  const a = await canvasFrame(ben.page);
  await ben.page.waitForTimeout(500);
  assert.notEqual(a, await canvasFrame(ben.page), "the loop is playing");
  await snap(ben.page, "11-feed-playing");
  await item(ben.page, L1).locator(".frame").click();
  assert.equal(await item(ben.page, L1).locator(".frame").getAttribute("aria-pressed"), "false");

  // Sound: Ana plays Ben's loop.
  await openFriends(ana.page);
  await item(ana.page, L2).locator(".frame").click();
  await item(ana.page, L2).locator('.frame[data-state="playing"][data-sound="on"]').waitFor({ timeout: 30_000 });

  // Keyboard: the menu opens from the keyboard, Escape closes it, focus comes back.
  await item(ana.page, L2).locator(".more").focus();
  await ana.page.keyboard.press("Enter");
  await sheet(ana.page).waitFor();
  assert.equal(await ana.page.evaluate(() => document.activeElement?.closest("dialog") !== null), true, "focus moves into the menu");
  await ana.page.keyboard.press("Escape");
  await ana.page.waitForFunction(() => !document.querySelector("dialog.sheet[open]"));
  assert.equal(await ana.page.evaluate(() => document.activeElement?.classList.contains("more")), true, "focus returns to the menu button");
  await item(ana.page, L1).locator(".more").click();
  await sheetButton(ana.page, "Delete").waitFor();
  await snap(ana.page, "12-menu-own-loop", { fullPage: false });
  await sheetButton(ana.page, "Cancel").click();

  // ---- report from the menu: the loop is hidden -------------------------------------------------
  await item(ben.page, L1).locator(".more").click();
  await sheetButton(ben.page, `Block @${handles.ana}`).waitFor();
  await snap(ben.page, "13-menu", { fullPage: false });
  await sheetButton(ben.page, "Report").click();
  await sheetButton(ben.page, "Harassment").waitFor();
  assert.equal(await sheet(ben.page).getByRole("button").count(), 10, "nine reasons and Cancel");
  await snap(ben.page, "14-report-reasons", { fullPage: false });
  await sheetButton(ben.page, "Harassment").click();
  await waitText(ben.page, "#toast", /^Thanks\. A person will look at it\.$/);
  assert.equal(await item(ben.page, L1).count(), 0, "the reported loop is hidden");
  await openFriends(ben.page);
  assert.deepEqual((await feedIds(ben.page)).sort(), [L2, L3].sort(), "and stays hidden for the person who reported it");

  // A child-safety report hides it for everyone while a person checks it.
  await openFriends(cy.page);
  for (const [id, reason] of [
    [L1, "Child safety"],
    [L3, "Something else"],
  ]) {
    await item(cy.page, id).locator(".more").click();
    await sheetButton(cy.page, "Report").click();
    await sheetButton(cy.page, reason).click();
    await waitText(cy.page, "#toast", /^Thanks\. A person will look at it\.$/);
  }
  await openFriends(ana.page, "mine");
  await item(ana.page, L1).getByText("Waiting for a quick check").waitFor();
  assert.equal(await item(ana.page, L3).locator(".state").textContent(), "");
  await posterLoaded(ana.page, L1);
  await snap(ana.page, "15-your-loops");
  await item(ana.page, L1).locator(".frame").click();
  await playing(ana.page, L1); // you can still watch your own held loop
  assert.ok(!(await ana.api("/irl/feed")).body.loops.some((l) => l.id === L1), "a held loop is out of the feed");

  // ---- review: reviewers only; restore, escalate, remove ----------------------------------------
  await ana.page.goto(`${base}/review/`, { waitUntil: "networkidle" });
  await waitText(ana.page, "h1", /^Reviewers only\.$/);
  assert.equal(await ana.page.getByRole("button", { name: "Sign in" }).count(), 0);
  await snap(ana.page, "16-review-reviewers-only");

  // The queue is everyone's: keep only this run's loops, so other runs sharing the database don't show up.
  await cy.page.route("**/api/auth/irl/admin/queue", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.items = body.items.filter((i) => Object.values(handles).includes(i.handle));
    await route.fulfill({ response: res, json: body });
  });
  await cy.page.goto(`${base}/review/`, { waitUntil: "networkidle" });
  const case1 = item(cy.page, L1);
  await case1.waitFor();
  await cy.page.waitForFunction((id) => [...document.querySelectorAll(`li[data-id="${id}"] .stills img`)].filter((i) => i.complete && i.naturalWidth > 0).length === 3, L1);
  assert.match(await case1.innerText(), /stub review/);
  assert.match(await case1.innerText(), /2 reports/i);
  assert.match(await case1.innerText(), /Harassment/);
  assert.match(await case1.innerText(), /Child safety/);
  await snap(cy.page, "17-review-queue");
  await case1.getByRole("button", { name: "Restore" }).click();
  await waitText(cy.page, "#toast", /^Restored\.$/);
  await case1.waitFor({ state: "detached" });

  await item(cy.page, L3).getByRole("button", { name: "Escalate" }).click();
  await sheetButton(cy.page, "Escalate").waitFor();
  await snap(cy.page, "18-review-escalate-confirm", { fullPage: false });
  await sheetButton(cy.page, "Escalate").click();
  await waitText(cy.page, "#toast", /^Escalated\.$/);
  await item(cy.page, L3).getByText("Child-safety escalation").waitFor();
  assert.equal(await item(cy.page, L3).locator("img").count(), 0, "escalations are never previewed");
  await snap(cy.page, "19-review-escalated");
  await item(cy.page, L3).getByRole("button", { name: "Remove" }).click();
  await waitText(cy.page, "#main", /Nothing to review\./);
  await snap(cy.page, "20-review-empty");

  // Restored: back in the feed.
  await openFriends(ana.page);
  assert.deepEqual((await feedIds(ana.page)).sort(), [L1, L2].sort());

  // ---- block from the menu: their loops go, and so does the friendship ---------------------------
  await item(ana.page, L2).locator(".more").click();
  await sheetButton(ana.page, `Block @${handles.ben}`).click();
  await sheet(ana.page).getByRole("heading", { name: `Block @${handles.ben}?` }).waitFor();
  await snap(ana.page, "21-block-confirm", { fullPage: false });
  await sheetButton(ana.page, `Block @${handles.ben}`).click();
  await waitText(ana.page, "#toast", new RegExp(`^Blocked @${re(handles.ben)}\\.$`));
  assert.deepEqual(await feedIds(ana.page), [L1]);
  await waitText(ana.page, "#feed-panel .end", /^You’re caught up\.$/);
  await snap(ana.page, "22-feed-caught-up");
  await ana.page.locator('.tabs a[href="#friends"]').click();
  await ana.page.locator("#friends-panel .row", { hasText: `@${handles.cy}` }).waitFor();
  assert.equal(await ana.page.locator("#friends-panel .row", { hasText: `@${handles.ben}` }).count(), 0);
  await openFriends(ben.page);
  assert.deepEqual(await feedIds(ben.page), [L2]);

  // ---- remove a friend, delete a loop ------------------------------------------------------------
  await openFriends(cy.page, "friends");
  await cy.page.getByRole("button", { name: `Options for @${handles.ana}` }).click();
  await sheetButton(cy.page, `Remove @${handles.ana}`).click();
  await sheetButton(cy.page, "Remove").click();
  await waitText(cy.page, "#toast", new RegExp(`^Removed @${re(handles.ana)}\\.$`));
  await cy.page.locator("#friends-panel").getByText("No friends yet.").waitFor();

  await openFriends(ana.page);
  await item(ana.page, L1).locator(".more").click();
  await sheetButton(ana.page, "Delete").click();
  await sheet(ana.page).getByRole("heading", { name: "Delete this loop?" }).waitFor();
  await sheetButton(ana.page, "Delete").click();
  await waitText(ana.page, "#toast", /^Deleted\.$/);
  await ana.page.locator("#feed-panel").getByText("No loops yet.").waitFor();
  await waitText(ana.page, "#feed-panel .end", /^You’re caught up\.$/);
  assert.equal((await db.query(`select 1 from irl_loop where "id" = $1`, [L1])).rows.length, 0);

  // ---- nothing left irl.ing, nothing broke ------------------------------------------------------
  const elsewhere = requested.filter((url) => !url.startsWith(`${base}/`) && !url.startsWith("data:") && !url.startsWith("blob:"));
  assert.deepEqual(elsewhere, [], "no third-party requests");
  for (const p of people) assert.deepEqual(p.errors, [], p.handle ?? "guest");
  console.log(
    `screens ok: signed out, invite (link, QR, copy, signed out → sign in, signed in, expired, new person), add by @name, accept, decline, ` +
      `real lab loop shared with share.js (stills from player frames, I420 and a big canvas), feed posters, playback with an expired-link refetch, sound, ` +
      `keyboard menu, report, child-safety hold, your loops, review (reviewers only, restore, escalate, remove), block, remove friend, delete, caught up` +
      (shots ? ` · ${snaps} screenshots in ${shots}` : ""),
  );
} finally {
  await browser.close();
  server.kill();
  await db.end();
  await rm(storageDir, { recursive: true, force: true });
}
