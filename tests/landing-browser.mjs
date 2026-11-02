// Browser check for the landing page at phone and desktop sizes. Run
// against a server:
//   npm run build && PORT=3003 npm start
//   STUDIO_URL=http://127.0.0.1:3003 node tests/landing-browser.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

// Playwright is installed globally in the test environment, not as a dependency.
const { chromium } = createRequire(import.meta.url)("playwright");

const base = process.env.STUDIO_URL ?? "http://127.0.0.1:3001";
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

try {
  for (const [name, viewport, mobile] of [
    ["phone", { width: 390, height: 844 }, true],
    ["desktop", { width: 1440, height: 900 }, false],
  ]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    assert.equal(await page.title(), "irl.ing — six-second social video. Less scrolling, more irl’ing.");
    assert.equal(await page.locator(".terms dt").count(), 9, "the lexicon");
    assert.equal(await page.locator("a[href='/loops/']").first().isVisible(), true);

    // The hero loop is live.
    await page.waitForTimeout(2600);
    const frame = () => page.locator("#hero-stage canvas").evaluate((c) => c.toDataURL());
    const a = await frame();
    await page.waitForTimeout(300);
    assert.notEqual(a, await frame(), `${name}: hero loop should animate`);

    // Hold to record: two takes, timed by the real hold, auto-finish at six seconds.
    const hold = page.locator("#hold");
    await hold.scrollIntoViewIfNeeded();
    const box = await hold.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1500);
    await page.mouse.up();
    assert.match(await page.locator("#try-caption").innerText(), /^Paused at 1\.[4-6]s\. Hold to keep going\.$/);
    assert.match(await page.locator("#stage-label").innerText(), /^PAUSED · TAKE 1$/);
    await page.mouse.down();
    await page.waitForTimeout(4900);
    await page.mouse.up();
    assert.match(await page.locator("#try-caption").innerText(), /^That’s a loop: 2 takes, six seconds\./);
    assert.equal(await page.locator("#meter-ticks i").count(), 1);

    // Transit diagram.
    await page.locator("#lexicon").scrollIntoViewIfNeeded();
    await page.click('[data-transit="relay"]');
    assert.equal(await page.locator(".blk.extra.gone").count(), 3);
    assert.match(await page.locator("#chunks-note").innerText(), /without opening the file/);
    await page.click('[data-transit="flip"]');
    assert.equal(await page.locator(".blk.broken").count(), 1);
    await page.click('[data-transit="cut"]');
    assert.ok(await page.locator("#strip").evaluate((s) => s.classList.contains("cut")));

    // Smart pixels section animates on its own until touched.
    await page.locator("#pixels").scrollIntoViewIfNeeded();
    const before = await page.locator("#pixels-look").inputValue();
    await page.waitForTimeout(1200);
    assert.notEqual(before, await page.locator("#pixels-look").inputValue());

    const overflow = await page.evaluate(
      () => Math.max(...[...document.querySelectorAll("body *")].map((e) => e.getBoundingClientRect().right)) - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 0.5, `${name}: content overflows by ${overflow}px`);
    if (shots) await page.screenshot({ path: `${shots}/landing-${name}.png`, fullPage: true });
    assert.deepEqual(errors, [], `${name}: browser errors`);
    await context.close();
  }
  console.log("landing ok: phone and desktop");
} finally {
  await browser.close();
}
