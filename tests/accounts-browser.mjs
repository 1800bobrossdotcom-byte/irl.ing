// End-to-end accounts check: real Better Auth server, real Postgres, real
// WebAuthn ceremonies through Chromium's virtual authenticator.
//
//   DATABASE_URL=postgres://... BETTER_AUTH_SECRET=... BETTER_AUTH_URL=http://localhost:3004 npm run db:migrate
//   npm run build && (same env) PORT=3004 node scripts/serve-local.mjs
//   SITE_URL=http://localhost:3004 node tests/accounts-browser.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.SITE_URL ?? "http://localhost:3004";
const unique = Date.now().toString(36).slice(-5);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** A fresh "phone": its own cookies and its own platform authenticator. */
async function phone() {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const setVerified = (isUserVerified) => cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified });
  await page.goto(`${base}/loops/`, { waitUntil: "networkidle" });
  return { context, page, errors, setVerified };
}

const text = (page, id) => page.locator(id).innerText();
const waitText = (page, id, re) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ""), [id, re.source], { timeout: 20_000 });
const me = (page) => page.evaluate(() => fetch("/api/auth/irl/me").then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })));

async function claim(page, { handle, birthYear, birthMonth = 3 }) {
  await page.locator("#handle").fill(handle);
  await page.locator("#birth-month").selectOption(String(birthMonth));
  await page.locator("#birth-year").selectOption(String(birthYear));
  if (!(await page.locator("#accept-rules").isChecked())) await page.locator("#accept-rules").check();
  await page.locator("#claim-continue").click();
}

try {
  const a = await phone();
  const { page } = a;

  // The button appears once the server says accounts are on.
  await waitText(page, "#account-open", /^Claim your @name$/);
  await page.locator("#account-open").click();
  assert.equal(await page.locator('.step[data-step="claim"]').isVisible(), true);

  // Instant feedback while typing, then the server's word on availability.
  await page.locator("#handle").fill("9x");
  await waitText(page, "#handle-note", /At least 3/);
  await page.locator("#handle").fill("Support");
  await waitText(page, "#handle-note", /reserved/);
  const handle = `sun.${unique}`;
  await page.locator("#handle").fill(handle);
  await waitText(page, "#handle-note", new RegExp(`@${handle.replace(".", "\\.")} is yours`));

  // Under 13: refused, and nothing is held.
  await claim(page, { handle, birthYear: new Date().getFullYear() - 10 });
  await waitText(page, "#claim-error", /13 and up/);

  // An adult claim, then a passkey without the fingerprint/face check is refused.
  await claim(page, { handle, birthYear: 1994 });
  await waitText(page, "#save-handle", new RegExp(`@${handle}`));
  assert.equal(await page.locator("#save-teen").isHidden(), true);
  await a.setVerified(false);
  await page.locator("#save-passkey").click();
  await waitText(page, "#save-error", /./);
  assert.equal((await me(page)).status, 401, "no account without user verification");

  // With the check: account, passkey and session in one go.
  await a.setVerified(true);
  await page.locator("#save-passkey").click();
  await waitText(page, "#done-handle", new RegExp(`^@${handle}$`));
  assert.match(await text(page, "#done-privacy"), /^Friends-only to start/);
  const account = await me(page);
  assert.deepEqual(account.body, { handle, name: handle, visibility: "friends", discoverable: true, teen: false });
  await page.locator("#done-close").click();
  await waitText(page, "#account-open", new RegExp(`^@${handle}$`));

  // The account survives a reload; the placeholder email never leaks.
  await page.reload({ waitUntil: "networkidle" });
  await waitText(page, "#account-open", new RegExp(`^@${handle}$`));
  assert.ok(!JSON.stringify(account.body).includes("invalid"));

  // Sign out, then back in with the passkey.
  await page.locator("#account-open").click();
  await page.locator("#sign-out").click();
  await waitText(page, "#account-open", /^Claim your @name$/);
  assert.equal((await me(page)).status, 401);
  await page.locator("#account-open").click();
  await page.locator("#to-signin").click();
  await page.locator("#signin-passkey").click();
  await waitText(page, "#account-handle", new RegExp(`^@${handle}$`));

  // A second phone can't take the same @name.
  const b = await phone();
  await b.page.locator("#account-open").click();
  await b.page.locator("#handle").fill(handle);
  await waitText(b.page, "#handle-note", /taken/);
  await claim(b.page, { handle, birthYear: 1990 });
  await waitText(b.page, "#claim-error", /taken/);

  // A 15-year-old starts friends-only and can't be found by strangers.
  const teen = `teen_${unique}`;
  await claim(b.page, { handle: teen, birthYear: new Date().getFullYear() - 15, birthMonth: 1 });
  await waitText(b.page, "#save-handle", new RegExp(`@${teen}`));
  assert.equal(await b.page.locator("#save-teen").isVisible(), true);
  await b.page.locator("#save-passkey").click();
  await waitText(b.page, "#done-privacy", /under 18/);
  assert.deepEqual((await me(b.page)).body, { handle: teen, name: teen, visibility: "friends", discoverable: false, teen: true });

  // Delete: wrong confirmation is refused, the right one removes everything.
  await page.locator('details.danger summary').click();
  await page.locator("#delete-confirm").fill("someone_else");
  await page.locator("#delete-account").click();
  await waitText(page, "#delete-error", /Type your @name/);
  await page.locator("#delete-confirm").fill(`@${handle}`);
  await page.locator("#delete-account").click();
  await waitText(page, "#account-open", /^Claim your @name$/);
  assert.equal((await me(page)).status, 401);
  const again = await page.evaluate((h) => fetch("/api/auth/irl/check-handle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: h }) }).then((r) => r.json()), handle);
  assert.equal(again.available, true, "the deleted @name is free again");
  // Its passkey no longer signs anyone in.
  await page.locator("#account-open").click();
  await page.locator("#to-signin").click();
  await page.locator("#signin-passkey").click();
  await waitText(page, "#signin-error", /./);
  assert.equal((await me(page)).status, 401);

  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  console.log(`accounts ok: @${handle} signed up, out, in, deleted; @${teen} is a protected teen account`);
} finally {
  await browser.close();
}
