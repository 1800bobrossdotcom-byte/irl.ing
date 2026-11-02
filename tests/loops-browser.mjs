// Browser check for the loops lab at an Android phone size, using Chromium's
// fake camera and microphone. Run against a server:
//   npm run build && PORT=3003 npm start
//   STUDIO_URL=http://127.0.0.1:3003 node tests/loops-browser.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Playwright is installed globally in the test environment, not as a dependency.
const { chromium } = createRequire(import.meta.url)("playwright");

const base = process.env.STUDIO_URL ?? "http://127.0.0.1:3001";
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH && { executablePath: process.env.CHROMIUM_PATH }),
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  acceptDownloads: true,
  permissions: ["camera", "microphone"],
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
const shot = (name) => shots && page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
const kb = async (id) => parseFloat(await page.locator(id).innerText());
const frameOf = () => page.locator("#dots").evaluate((c) => c.toDataURL());

try {
  await page.goto(`${base}/loops/`, { waitUntil: "networkidle" });
  await shot("1-start");

  // Sample clip: dots appear, animate, and report a small file.
  await page.locator("#try-sample").click();
  await page.waitForFunction(() => document.querySelector("#size-recipe").textContent.includes("KB"));
  const first = await frameOf();
  await page.waitForTimeout(700);
  assert.notEqual(first, await frameOf(), "dots should be moving");
  const at64 = await kb("#size-recipe");
  assert.ok(at64 > 1 && at64 < 120, `64² sample is ${at64} KB`);
  await shot("2-sample-dots");

  await page.locator('[data-setting="grid"] button[data-value="128"]').click();
  await page.waitForFunction((before) => parseFloat(document.querySelector("#size-recipe").textContent) > before, at64);
  assert.equal(await page.locator("#dot-count").innerText(), "16,384 · 36 keys");

  await page.locator("#compare").click();
  await page.waitForFunction(() => document.querySelectorAll(".rung").length === 5);
  await page.locator(".rung").nth(1).click();
  await page.waitForFunction(() => document.querySelector("#dot-count").textContent.startsWith("2,304"));
  await page.waitForTimeout(400);
  await shot("3-compare");

  // The downloaded file alone rebuilds the loop.
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download").click()]);
  const bytes = readFileSync(await download.path());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x49, 0x52, 0x4c, 0x44]);
  await page.locator("#open-file").setInputFiles({ name: "loop.irl", mimeType: "application/octet-stream", buffer: bytes });
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Opened loop"));
  assert.equal(await page.locator("#dot-count").innerText(), "2,304 · 36 keys");
  assert.ok(await page.locator('[data-setting="grid"] button').first().isDisabled());
  await page.locator("#open-file").setInputFiles({ name: "x.irl", mimeType: "application/octet-stream", buffer: Buffer.from("nope") });
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("isn’t a loop"));

  // Camera: hold, let go, hold again until six seconds stop it by themselves.
  await page.locator("#again").click();
  await page.locator("#camera-on").click();
  await page.waitForFunction(() => document.querySelector("#live").videoWidth > 0);
  const record = page.locator("#record");
  await record.scrollIntoViewIfNeeded();
  const box = await record.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await shot("4-recording");
  await page.mouse.up();
  assert.match(await page.locator("#status").innerText(), /^Paused\. 4\.\ds left/);
  assert.equal(await page.locator("#done").isDisabled(), false);
  assert.ok(await page.locator("#flip").isDisabled(), "camera switching locks after the first take");
  assert.equal(await page.locator("#size-recipe").innerText(), "—", "no stale numbers from the last loop");
  await page.mouse.down();
  await page.waitForFunction(
    () => !document.querySelector("#build").hidden && document.querySelector("#size-recipe").textContent.includes("KB"),
    null,
    { timeout: 15_000 },
  );
  await page.mouse.up();
  assert.equal(await page.locator(".ticks i").count(), 1, "one pause mark between two takes");
  assert.match(await page.locator("#size-raw").innerText(), /KB|MB/);
  assert.match(await page.locator("#size-ratio").innerText(), /^\d+×$/);
  // The resolution chosen on the last loop carries over to the next one.
  assert.match(await page.locator("#dot-count").innerText(), /^2,304 · 3[56] keys$/);
  await page.waitForTimeout(500);
  await shot("5-camera-dots");
  await page.locator("#view-raw").click();
  await page.waitForFunction(() => !document.querySelector("#raw").hidden && document.querySelector("#raw").readyState >= 2);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  console.log(
    "loops lab ok:",
    JSON.stringify({ sample64: `${at64} KB`, camera: await page.locator(".readout").innerText() }).replaceAll("\\n", " "),
  );
} finally {
  await browser.close();
}
assert.deepEqual(errors, [], "browser JavaScript errors");
