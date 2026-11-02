import test from "node:test";
import assert from "node:assert/strict";
import { estimateGrain, grainTemplate } from "../src/loops/grain.js";
import { psnr, rgbaToI420 } from "../src/loops/yuv.js";

function stats(g, size) {
  let variance = 0;
  let lag = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = g[y * size + x];
      variance += v * v;
      lag += v * g[y * size + ((x + 1) % size)];
    }
  }
  return { std: Math.sqrt(variance / g.length), corr: lag / variance };
}

test("grain templates have unit strength and the requested grain size", () => {
  for (const corr of [0, 0.3, 0.6]) {
    const s = stats(grainTemplate(corr), 128);
    assert.ok(Math.abs(s.std - 1) < 1e-3);
    assert.ok(Math.abs(s.corr - corr) < 0.05, `asked ${corr}, got ${s.corr.toFixed(3)}`);
  }
  assert.deepEqual(grainTemplate(0.4), grainTemplate(0.4), "every device draws the same grain");
});

test("grain lost by the encoder is measured from source and decoded frames", () => {
  const size = 128;
  const pairs = [0, 1, 2].map((seed) => {
    const noise = grainTemplate(0.4, size, 1000 + seed);
    const decoded = new Uint8Array(size * size);
    const source = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        decoded[i] = 40 + Math.floor((x / size) * 160); // smooth ramp: what the codec kept
        source[i] = Math.max(0, Math.min(255, Math.round(decoded[i] + 4 * noise[i])));
      }
    }
    return { source, decoded };
  });
  const grain = estimateGrain(pairs, size, size);
  const measured = grain.strength.slice(1, 6);
  for (const s of measured) assert.ok(Math.abs(s - 4) < 0.7, `strength ${s}`);
  assert.ok(Math.abs(grain.corr - 0.4) < 0.15, `corr ${grain.corr}`);
});

test("busy pictures with no flat areas report no grain rather than guessing", () => {
  const size = 64;
  const busy = Uint8Array.from({ length: size * size }, (_, i) => ((i * 97) % 256));
  assert.equal(estimateGrain([{ source: busy, decoded: busy.map((v) => 255 - v) }], size, size), null);
});

test("BT.709 limited-range conversion and PSNR", () => {
  const rgba = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 128, 128, 128, 255]);
  const yuv = rgbaToI420(rgba, 2, 2);
  assert.deepEqual([...yuv.subarray(0, 4)], [16, 235, 126, 126]);
  assert.deepEqual([yuv[4], yuv[5]], [128, 128], "neutral grays carry no color");
  assert.equal(psnr(yuv, yuv), Infinity);
  assert.ok(Math.abs(psnr(new Uint8Array([10, 10]), new Uint8Array([12, 8])) - 42.11) < 0.01);
});
