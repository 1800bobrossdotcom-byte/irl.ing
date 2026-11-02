import test from "node:test";
import assert from "node:assert/strict";
import { bilinear2x, blockMismatches, easu2x, honestZoom, lockPlane, verifyFrame } from "../src/loops/honest-zoom.js";

function seeded(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

test("the lock makes every 2×2 block average exactly to the received pixel", () => {
  const random = seeded(1);
  const w = 37;
  const h = 23;
  const src = Uint8Array.from({ length: w * h }, () => Math.floor(random() * 256));
  const up = Uint8Array.from({ length: 4 * w * h }, () => Math.floor(random() * 256)); // a terrible upscaler
  assert.ok(blockMismatches(up, src, w, h) > w * h * 0.9);
  lockPlane(up, src, w, h);
  assert.equal(blockMismatches(up, src, w, h), 0);
});

test("the lock reaches the target even when values pin at 0 and 255", () => {
  // Every combination of extreme blocks against extreme and middle targets.
  const extremes = [0, 1, 254, 255, 128];
  const cases = [];
  for (const a of extremes) for (const b of extremes) for (const c of extremes) for (const d of extremes) cases.push([a, b, c, d]);
  for (const target of [0, 1, 2, 127, 253, 254, 255]) {
    for (const block of cases) {
      const up = Uint8Array.from(block);
      lockPlane(up, Uint8Array.of(target), 1, 1);
      assert.equal(up[0] + up[1] + up[2] + up[3], 4 * target, `${block} → ${target}`);
    }
  }
});

test("the lock leaves an already-faithful upscale untouched", () => {
  const random = seeded(2);
  const w = 20;
  const src = Uint8Array.from({ length: w * w }, () => Math.floor(random() * 256));
  const up = new Uint8Array(4 * w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) up[(2 * y + dy) * 2 * w + 2 * x + dx] = src[y * w + x];
  const before = up.slice();
  lockPlane(up, src, w, w);
  assert.deepEqual(up, before);
});

test("the lock only moves values as far as it must", () => {
  const random = seeded(3);
  const w = 32;
  const src = Uint8Array.from({ length: w * w }, () => 30 + Math.floor(random() * 190));
  const up = bilinear2x(src, w, w);
  const before = up.slice();
  lockPlane(up, src, w, w);
  let worst = 0;
  for (let i = 0; i < up.length; i++) worst = Math.max(worst, Math.abs(up[i] - before[i]));
  // Bilinear is close to faithful already; the lock nudges, it doesn't repaint.
  assert.ok(worst <= 64, `largest change ${worst}`);
});

test("EASU sharpens edges without ringing past the local range", () => {
  const w = 16;
  const src = new Uint8Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) src[y * w + x] = x < w / 2 ? 40 : 200;
  const out = easu2x(src, w, w);
  for (const v of out) assert.ok(v >= 40 && v <= 200, `value ${v} outside the source range`);
  const W = 2 * w;
  // Rows across the edge: EASU's transition is at least as steep as bilinear's.
  const lin = bilinear2x(src, w, w);
  const rowE = Array.from(out.subarray(10 * W + 12, 10 * W + 20));
  const rowB = Array.from(lin.subarray(10 * W + 12, 10 * W + 20));
  const steep = (r) => Math.max(...r.slice(1).map((v, i) => Math.abs(v - r[i])));
  assert.ok(steep(rowE) >= steep(rowB));
});

test("a whole I420 frame zooms 2× and verifies, luma and color", () => {
  const random = seeded(4);
  const size = 24;
  const c = size / 2;
  const src = Uint8Array.from({ length: size * size + 2 * c * c }, () => Math.floor(random() * 256));
  const zoomed = honestZoom(src, size);
  assert.equal(zoomed.length, 4 * src.length);
  assert.deepEqual(verifyFrame(zoomed, src, size), { blocks: size * size + 2 * c * c, mismatched: 0 });
  zoomed[5] ^= 1;
  assert.equal(verifyFrame(zoomed, src, size).mismatched, 1, "one changed value is caught");
});
