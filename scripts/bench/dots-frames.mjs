// Encode captured 160×160 RGB frames (12 fps) with the dots codec and write
// the held keyframes as 180 raw RGB frames at 29.97 fps. Prints .irl bytes.
//   node dots-frames.mjs cap160.rgb <grid> <buckets> <fps> <out.rgb>
import { readFileSync, writeFileSync } from "node:fs";
import { computePaths, encodeFrames, pickKeyframes, renderKeyframe, resampleSquare, serialize } from "../../src/loops/dots-codec.js";

const [input, grid, buckets, fps, output] = process.argv.slice(2).map((v, i) => (i && i < 4 ? Number(v) : v));
const S = 160;
const cap = readFileSync(input);
const count = cap.length / (S * S * 3);
const frames = Array.from({ length: count }, (_, i) => cap.subarray(i * S * S * 3, (i + 1) * S * S * 3));
const picks = pickKeyframes(count, 12, fps);
const recipe = encodeFrames(picks.map((i) => resampleSquare(frames[i], S, grid, 3)), { grid, fps, buckets });
const paths = computePaths(recipe);
const out = Buffer.alloc(180 * grid * grid * 3);
for (let f = 0; f < 180; f++) {
  const k = Math.min(recipe.frameCount - 1, Math.floor((f / 30) * fps));
  out.set(renderKeyframe(recipe, paths, k), f * grid * grid * 3);
}
writeFileSync(output, out);
console.log((await serialize(recipe)).length);
