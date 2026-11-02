import test from "node:test";
import assert from "node:assert/strict";
import {
  computePaths,
  encodeFrames,
  hilbertOrder,
  parse,
  pickKeyframes,
  renderKeyframe,
  resampleSquare,
  serialize,
} from "../src/loops/dots-codec.js";

/** A moving warm sun over a cool gradient: color, brightness and motion. */
function syntheticClip(grid, count) {
  const frames = [];
  for (let f = 0; f < count; f++) {
    const rgb = new Uint8Array(grid * grid * 3);
    const cx = grid * (0.25 + (0.5 * f) / count);
    const cy = grid * 0.45;
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const i = (y * grid + x) * 3;
        const inSun = (x - cx) ** 2 + (y - cy) ** 2 < (grid * 0.18) ** 2;
        rgb[i] = inSun ? 250 : 40 + (y * 120) / grid;
        rgb[i + 1] = inSun ? 190 : 70 + (y * 60) / grid;
        rgb[i + 2] = inSun ? 60 : 160 - (y * 80) / grid;
      }
    }
    frames.push(rgb);
  }
  return frames;
}

function meanAbsError(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

test("every keyframe is a full rearrangement of the same dots", () => {
  const grid = 24;
  const recipe = encodeFrames(syntheticClip(grid, 12), { grid, fps: 6, buckets: 16 });
  const paths = computePaths(recipe);
  const cells = grid * grid;
  for (let f = 0; f < recipe.frameCount; f++) {
    const seen = new Set(paths.subarray(f * cells, (f + 1) * cells));
    assert.equal(seen.size, cells, `frame ${f} leaves holes or doubles dots`);
  }
});

test("rearranged dots reproduce the picture far better than a flat average", () => {
  const grid = 32;
  const frames = syntheticClip(grid, 12);
  const recipe = encodeFrames(frames, { grid, fps: 6, buckets: 32 });
  const paths = computePaths(recipe);
  const flat = new Uint8Array(frames[0].length);
  for (let ch = 0; ch < 3; ch++) {
    let sum = 0;
    for (let i = ch; i < flat.length; i += 3) sum += frames[0][i];
    for (let i = ch; i < flat.length; i += 3) flat[i] = sum / (flat.length / 3);
  }
  for (const f of [0, 5, 11]) {
    const error = meanAbsError(renderKeyframe(recipe, paths, f), frames[f]);
    assert.ok(error < meanAbsError(flat, frames[f]) / 3, `frame ${f} error ${error.toFixed(1)}`);
  }
});

test("dots move coherently: most travel a short distance between keyframes", () => {
  const grid = 48;
  const recipe = encodeFrames(syntheticClip(grid, 12), { grid, fps: 6, buckets: 16 });
  const paths = computePaths(recipe);
  const cells = grid * grid;
  let total = 0;
  for (let d = 0; d < cells; d++) {
    const a = paths[cells + d];
    const b = paths[2 * cells + d];
    total += Math.hypot((a % grid) - (b % grid), Math.floor(a / grid) - Math.floor(b / grid));
  }
  // A random shuffle would average about half the grid width.
  assert.ok(total / cells < grid * 0.12, `mean step ${(total / cells).toFixed(2)} cells`);
});

test("serialized loops round-trip exactly, including sound, and stay small", async () => {
  const grid = 64;
  const recipe = encodeFrames(syntheticClip(grid, 36), { grid, fps: 6, buckets: 16 });
  recipe.audio = { mime: "audio/webm;codecs=opus", bytes: new Uint8Array([1, 2, 3, 4, 5]) };
  const bytes = await serialize(recipe);
  const back = await parse(bytes);
  assert.deepEqual(back.colors, recipe.colors);
  assert.deepEqual(back.labels, recipe.labels);
  assert.deepEqual(back.audio, recipe.audio);
  assert.equal(back.grid, grid);
  assert.equal(back.frameCount, 36);
  assert.deepEqual(computePaths(back), computePaths(recipe));
  // 36 keyframes of 4,096 dots: far below even a compressed 6-second video.
  assert.ok(bytes.length < 60_000, `${bytes.length} bytes`);
});

test("damaged or foreign files are refused", async () => {
  const grid = 16;
  const bytes = await serialize(encodeFrames(syntheticClip(grid, 4), { grid, fps: 4, buckets: 8 }));
  await assert.rejects(parse(new Uint8Array([1, 2, 3])), /not an irl.ing loop/);
  await assert.rejects(parse(bytes.subarray(0, bytes.length - 10)));
  const wrongSize = bytes.slice();
  new DataView(wrongSize.buffer).setUint16(6, 17, true);
  await assert.rejects(parse(wrongSize));
});

test("resampling averages areas and keyframes are spread across the clip", () => {
  const src = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) src.set(i % 2 ? [200, 100, 0, 255] : [0, 100, 200, 255], i * 4);
  assert.deepEqual([...resampleSquare(src, 4, 1)], [100, 100, 100]);
  assert.equal(resampleSquare(src, 4, 3).length, 27);
  assert.deepEqual(pickKeyframes(72, 12, 6), Array.from({ length: 36 }, (_, k) => k * 2));
  assert.equal(pickKeyframes(72, 12, 12).length, 72);
  assert.equal(new Set(hilbertOrder(5)).size, 25);
});
