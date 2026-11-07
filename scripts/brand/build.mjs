// Builds the irl.ing logo files from their construction rules, so every
// asset comes from the same numbers. See docs/brand.md for the reasoning.
//
//   node scripts/brand/build.mjs          # SVGs only
//   node scripts/brand/build.mjs --png    # SVGs, then PNG icons and og.png (needs Playwright)
//
// The mark ("the take") is a real six-second loop: three takes of 2.6, 1.5
// and 1.9 seconds drawn clockwise from twelve o'clock as a ring, with a gap
// wherever the thumb let go, around the record dot. The wordmark is drawn on
// a 100-unit x-height: stems stand flat on the baseline, curves end round,
// and the three dots (two tittles and the period) are one size.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = (path, text) => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
  console.log("wrote", path);
};

export const COLOR = { ink: "#111110", chalk: "#F4F4F0", rec: "#F33A16", lime: "#D8F04A" };
export const TAKES = [2.6, 1.5, 1.9]; // seconds; they sum to six

const n = (v) => +v.toFixed(2);

/** Point on a circle, degrees clockwise from twelve o'clock. */
function at(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx, cy, r, a0, a1) {
  const [x0, y0] = at(cx, cy, r, a0);
  const [x1, y1] = at(cx, cy, r, a1);
  return `M${n(x0)} ${n(y0)}A${n(r)} ${n(r)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${n(x1)} ${n(y1)}`;
}

/** The take ring as centerline arcs with round caps and a visible gap in degrees. */
export function ring({ cx, cy, r, w, gap = 20, takes = TAKES, start = 0 }) {
  const total = takes.reduce((a, b) => a + b, 0);
  const trim = gap / 2 + ((w / 2 / r) * 180) / Math.PI;
  let deg = start;
  return takes
    .map((t) => {
      const span = (t / total) * 360;
      const d = arc(cx, cy, r, deg + trim, deg + span - trim);
      deg += span;
      return d;
    })
    .join("");
}

/** The mark on a 120 grid: ring radius 48, weight 12, dot radius 25, 20° gaps. */
export function markShapes({ x = 0, y = 0, size = 120, ringColor, dotColor, gap = 20, weight = 12 }) {
  const k = size / 120;
  const cx = x + 60 * k;
  const cy = y + 60 * k;
  const w = weight * k;
  const d = ring({ cx, cy, r: 48 * k, w, gap });
  return (
    `<path d="${d}" fill="none" stroke="${ringColor}" stroke-width="${n(w)}" stroke-linecap="round"/>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(25 * k)}" fill="${dotColor}"/>`
  );
}

/** The wordmark geometry, baseline at y = 142 (ascender top at 0). */
export function wordmarkGeometry(x0 = 2.5) {
  const S = 24; // stem
  const X = 100; // x-height
  const A = 142; // ascender
  const D = 29; // dot
  const BL = 142;
  const top = BL - X;
  const ov = 2; // overshoot of round shapes
  const stems = [];
  const curves = [];
  const dots = [];
  let rec;
  let x = x0;
  const stem = (cx, y0, y1) => stems.push(`M${n(cx)} ${n(y0)}V${n(y1)}`);
  const i = () => {
    stem(x + S / 2, BL, top);
    dots.push([x + S / 2, top - 13 - D / 2]);
    x += S;
  };
  // i
  i();
  x += 16;
  // r: a stem and a shoulder (radius 30) that ends round at 22° past twelve
  {
    const c = x + S / 2;
    const R = 30;
    const cy = top - ov + S / 2 + R;
    stem(c, BL, top);
    curves.push(arc(c + R, cy, R, 270, 382));
    x = at(c + R, cy, R, 22)[0] + S / 2;
  }
  x += 6;
  // l
  stem(x + S / 2, BL, BL - A);
  x += S + 13;
  // the period: the record dot
  rec = [x + D / 2, BL - D / 2];
  x += D + 13;
  // i
  i();
  x += 16;
  // n: stem, half-ring arch (radius 34), stem
  {
    const c = x + S / 2;
    const R = 34;
    const cy = top - ov + S / 2 + R;
    stem(c, BL, top);
    stems.push(arc(c + R, cy, R, 270, 450));
    stem(c + 2 * R, cy, BL);
    x += S + 2 * R;
  }
  x += 11;
  // g: a round bowl (radius 40), a stem from the x-height, a hook that ends round
  {
    const c = x + S / 2;
    const R = 40;
    const cy = BL - X / 2;
    stems.push(`M${n(c)} ${n(cy)}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0`);
    stem(c + 2 * R, top, BL + 2);
    curves.push(arc(c + R, BL + 2, R, 90, 236));
    x += S + 2 * R;
  }
  return { S, D, stems: stems.join(""), curves: curves.join(""), dots, rec, width: n(x), height: 196, baseline: BL };
}

/** Wordmark shapes; ink may be "currentColor" for inline use. */
export function wordmarkShapes({ ink, rec, x = 0, y = 0, scale = 1, g = wordmarkGeometry() }) {
  const t = x || y || scale !== 1 ? ` transform="translate(${n(x)} ${n(y)}) scale(${n(scale)})"` : "";
  const dot = ([cx, cy], fill, cls = "") => `<circle${cls} cx="${n(cx)}" cy="${n(cy)}" r="${g.D / 2}" fill="${fill}"/>`;
  return (
    `<g${t}>` +
    `<path d="${g.stems}" fill="none" stroke="${ink}" stroke-width="${g.S}"/>` +
    `<path d="${g.curves}" fill="none" stroke="${ink}" stroke-width="${g.S}" stroke-linecap="round"/>` +
    g.dots.map((p) => dot(p, ink)).join("") +
    dot(g.rec, rec) +
    `</g>`
  );
}

const svg = (w, h, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}"${title ? ` role="img" aria-label="${title}"` : ""}>${body}</svg>\n`;

// ---- files ---------------------------------------------------------------

export function build() {
  const g = wordmarkGeometry();
  const W = g.width + 2.5;

  for (const [suffix, ink, ringColor] of [
    ["", COLOR.ink, COLOR.ink],
    ["-reverse", COLOR.chalk, COLOR.chalk],
  ]) {
    out(`public/brand/mark${suffix}.svg`, svg(120, 120, markShapes({ ringColor, dotColor: COLOR.rec }), "irl.ing"));
    out(`public/brand/wordmark${suffix}.svg`, svg(W, g.height, wordmarkShapes({ ink, rec: COLOR.rec, g }), "irl.ing"));
    // Lockup: the mark's ring spans ascender to baseline (142), then a 50-unit gap.
    const m = 142 / 108; // ring outer diameter 108 on the 120 grid
    const size = 120 * m;
    const off = -6 * m;
    const lockW = 142 + 50 + W;
    out(
      `public/brand/lockup${suffix}.svg`,
      svg(lockW, g.height, markShapes({ x: off, y: off, size, ringColor, dotColor: COLOR.rec }) + wordmarkShapes({ ink, rec: COLOR.rec, x: 192, g }), "irl.ing"),
    );
  }

  // App icon, maskable: full bleed, the ring's outer radius (150 of 512) sits
  // inside Android's 66/108 safe circle (radius 156) and the web's 40% zone.
  const icon = (size, rx) => {
    const k = size / 512;
    const ringSize = (150 / 54) * 120 * k;
    const xy = size / 2 - ringSize / 2;
    return svg(
      size,
      size,
      `<rect width="${size}" height="${size}"${rx ? ` rx="${n(rx * k)}"` : ""} fill="${COLOR.ink}"/>` +
        markShapes({ x: xy, y: xy, size: ringSize, ringColor: COLOR.chalk, dotColor: COLOR.rec, weight: 11 }),
      "irl.ing",
    );
  };
  out("public/brand/app-icon-maskable.svg", icon(512, 0));
  out("public/brand/app-icon.svg", icon(512, 116));

  // Favicon, drawn for 16 px: a heavier ring and wider gaps on a 32 grid.
  const fav =
    `<rect width="32" height="32" rx="7.5" fill="${COLOR.ink}"/>` +
    `<path d="${ring({ cx: 16, cy: 16, r: 10.4, w: 3.2, gap: 26 })}" fill="none" stroke="${COLOR.chalk}" stroke-width="3.2" stroke-linecap="round"/>` +
    `<circle cx="16" cy="16" r="5.5" fill="${COLOR.rec}"/>`;
  out("public/favicon.svg", svg(32, 32, fav));
  out("public/brand-mark.svg", svg(120, 120, markShapes({ ringColor: COLOR.ink, dotColor: COLOR.rec })));

  return { g, W };
}

// ---- PNG renders -----------------------------------------------------------

async function renderPngs() {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  const shoot = async (html, w, h, path, transparent = false) => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${html}`);
    await page.screenshot({ path: resolve(root, path), omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
    console.log("rendered", path);
  };
  const { readFileSync } = await import("node:fs");
  const file = (p) => readFileSync(resolve(root, p), "utf8");
  const sized = (s, px) => s.replace("<svg ", `<svg width="${px}" height="${px}" `);
  for (const px of [192, 512]) {
    await shoot(sized(file("public/brand/app-icon.svg"), px), px, px, `public/brand/icon-${px}.png`, true);
    await shoot(sized(file("public/brand/app-icon-maskable.svg"), px), px, px, `public/brand/maskable-${px}.png`);
  }
  await shoot(sized(file("public/brand/app-icon-maskable.svg"), 180), 180, 180, "public/brand/apple-touch-icon.png");

  // Social share image, set in the brand's own (self-hosted) type.
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto(new URL("./og.html", import.meta.url).href);
  await page.evaluate((lockup) => (document.getElementById("lockup").innerHTML = lockup), file("public/brand/lockup.svg"));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(root, "public/brand/og.png"), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log("rendered public/brand/og.png");
  await browser.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build();
  if (process.argv.includes("--png")) await renderPngs();
}
