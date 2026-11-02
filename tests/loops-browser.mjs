// Browser check for the loops lab at an Android phone size, using Chromium's
// fake camera and microphone. Run against a server:
//   npm run build && PORT=3003 npm start
//   STUDIO_URL=http://127.0.0.1:3003 node tests/loops-browser.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const shot = (name, target = page) => shots && target.screenshot({ path: `${shots}/${name}.png`, ...(target === page && { fullPage: true }) });
const text = (id) => page.locator(id).innerText();
const kb = async (id) => parseFloat(await text(id));
const frameOf = () => page.locator("#player").evaluate((c) => c.toDataURL());
const waitFor = (fn, arg, timeout = 60_000) => page.waitForFunction(fn, arg, { timeout });
/** Stream summary from ffprobe, or null where ffprobe isn't installed. */
function probe(path) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames", "-of", "json", path]);
    return JSON.parse(out).streams;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
const saveVideo = async () => {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 180_000 }), page.locator("#save-video").click()]);
  assert.equal(download.suggestedFilename(), "irl-loop.mp4");
  const path = await download.path();
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp", "a real MP4");
  return { path, streams: probe(path) };
};
const transit = async (value, expect) => {
  await page.locator(`[data-setting="transit"] button[data-value="${value}"]`).click();
  await waitFor((e) => document.querySelector("#facts").textContent.includes(e), expect);
};

try {
  await page.goto(`${base}/loops/`, { waitUntil: "networkidle" });

  // Sample: encoded on this "phone", signed, measured, and playing.
  await page.locator("#try-sample").click();
  await waitFor(() => document.querySelector("#quality").textContent.includes("dB"));
  await page.waitForTimeout(500);
  await shot("1-assembling", page.locator("#stage"));
  assert.match(await text("#facts"), /^AV1 · 360² · 30 fps · 2 of 2 layers · video [\d.]+ KB · grain measured$/);
  const loopKb = await kb("#size-loop");
  assert.ok(loopKb > 70 && loopKb < 115, `100 KB budget gave ${loopKb} KB`);
  const quality = await kb("#quality");
  assert.ok(quality > 32, `sample quality ${quality} dB`);
  assert.match(await text("#trust"), /^Signed by device [0-9a-f]{8} · loop ID [0-9a-f]{12} · 7 of 7 signed parts present, all authentic$/);
  await page.waitForTimeout(2200); // assembly finished, lifelike
  const a = await frameOf();
  await page.waitForTimeout(400);
  assert.notEqual(a, await frameOf(), "the loop should be playing");
  await shot("2-lifelike", page.locator("#stage"));

  // Finishing off vs on, then the smart-pixel look.
  await page.locator('[data-setting="finish"] button[data-value="off"]').click();
  await page.waitForTimeout(300);
  await shot("3-unfinished", page.locator("#stage"));
  await page.locator('[data-setting="finish"] button[data-value="on"]').click();
  await page.locator("#look").fill("100");
  await page.waitForTimeout(300);
  await shot("4-smart-pixels", page.locator("#stage"));
  await page.locator("#look").fill("0");

  // Smaller budget re-encodes to a smaller, lower-quality loop.
  await page.locator('[data-setting="budget"] button[data-value="50"]').click();
  await waitFor((before) => parseFloat(document.querySelector("#size-loop").textContent) < before * 0.7, loopKb);
  await waitFor(() => document.querySelector("#status").textContent === "Here’s your loop.");
  const small = await kb("#quality");
  assert.ok(small < quality, `50 KB (${small} dB) should trail 100 KB (${quality} dB)`);
  await page.locator('[data-setting="budget"] button[data-value="100"]').click();
  await waitFor((q) => document.querySelector("#quality").textContent === q, `${quality.toFixed(1)} dB`);

  // In transit: relay trim, a flipped byte, a cut link.
  await transit("relay", "15 fps · 1 of 2 layers");
  assert.ok((await kb("#size-loop")) < loopKb * 0.75);
  assert.match(await text("#trust"), /· 4 of 7 signed parts present, all authentic$/);
  assert.match(await text("#transit-report"), /relay dropped the enhancement layer without decoding or re-signing/);
  await shot("5-relayed");
  await transit("damaged", "30 fps · 2 of 2 layers");
  await waitFor(() => document.querySelector("#transit-report").textContent.includes("Lost in transit: 2–4 s"));
  assert.match(await text("#transit-report"), /1 damaged chunk caught by checksum and skipped/);
  assert.match(await text("#trust"), /6 of 7 signed parts present, all authentic/);
  const held = await frameOf();
  await page.waitForTimeout(300);
  assert.notEqual(held, await frameOf(), "the surviving four seconds keep playing");
  await transit("cut", "15 fps · 1 of 2 layers");
  assert.match(await text("#transit-report"), /link dropped after 60%.*file ends early/);
  await transit("original", "30 fps · 2 of 2 layers");

  // Save video: an ordinary MP4 anyone can play, not the .irl.
  const mp4 = await saveVideo();
  assert.match(await text("#status"), /^Saved irl-loop\.mp4 \(MP4 · H\.264, no sound · [\d.]+ (KB|MB)\)\.$/);
  if (mp4.streams) {
    const [v] = mp4.streams;
    assert.deepEqual([v.codec_type, v.codec_name, v.width, v.height, Number(v.nb_read_frames)], ["video", "h264", 720, 720, 180]);
  }

  // The downloaded file alone reproduces the loop and its signature.
  const id = (await text("#trust")).match(/loop ID ([0-9a-f]{12})/)[1];
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download").click()]);
  const bytes = readFileSync(await download.path());
  assert.equal(bytes.subarray(0, 4).toString(), "IRL2");
  await page.locator("#open-file").setInputFiles({ name: "loop.irl", mimeType: "application/octet-stream", buffer: bytes });
  await waitFor(() => document.querySelector("#status").textContent.startsWith("Opened loop"));
  assert.match(await text("#trust"), new RegExp(`loop ID ${id} · 7 of 7 signed parts present, all authentic`));
  assert.ok(await page.locator('[data-setting="budget"] button').first().isDisabled());
  await page.locator("#open-file").setInputFiles({ name: "x.irl", mimeType: "application/octet-stream", buffer: Buffer.from("nope") });
  await waitFor(() => document.querySelector("#status").textContent.includes("isn’t a loop"));

  // Camera: hold, let go, hold again until six seconds stop it by themselves.
  await page.locator("#again").click();
  await page.locator("#camera-on").click();
  await waitFor(() => document.querySelector("#live").videoWidth > 0);
  const record = page.locator("#record");
  await record.scrollIntoViewIfNeeded();
  const box = await record.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();
  assert.match(await text("#status"), /^Paused\. 4\.\ds left/);
  assert.ok(await page.locator("#flip").isDisabled(), "camera switching locks after the first take");
  assert.equal(await text("#size-loop"), "—", "no stale numbers from the last loop");
  await page.mouse.down();
  await waitFor(() => !document.querySelector("#build").hidden && document.querySelector("#quality").textContent.includes("dB"));
  await page.mouse.up();
  assert.equal(await page.locator(".ticks i").count(), 1, "one pause mark between two takes");
  assert.match(await text("#facts"), /^AV1 · 360² · 30 fps · 2 of 2 layers · video [\d.]+ KB \+ sound [\d.]+ KB/);
  assert.match(await text("#size-raw"), /KB|MB/);
  assert.match(await text("#size-ratio"), /^\d+×$/);
  await page.waitForTimeout(2500);
  await shot("6-camera-loop");
  const cameraMp4 = await saveVideo();
  assert.match(await text("#status"), /^Saved irl-loop\.mp4 \(MP4 · H\.264, (AAC|Opus) sound · /);
  if (cameraMp4.streams) assert.deepEqual(cameraMp4.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
  await page.locator("#view-raw").click();
  await waitFor(() => !document.querySelector("#raw").hidden && document.querySelector("#raw").readyState >= 2);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  console.log(`loops lab ok: sample ${loopKb} KB at ${quality} dB (50 KB: ${small} dB); camera ${await text("#facts")}`);
} finally {
  await browser.close();
}
assert.deepEqual(errors, [], "browser JavaScript errors");
