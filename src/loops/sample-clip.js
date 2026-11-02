// The lab's built-in sample: six seconds of the drawn scene at 30 fps, with
// a little sensor-like noise so grain measurement has something real.

import { CAPTURE_FPS } from "./loop-recorder.js";
import { drawScene } from "./scene.js";
import { rgbaToI420 } from "./yuv.js";

export function sampleClip(size = 360, seconds = 6) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const frames = [];
  const count = seconds * CAPTURE_FPS;
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  for (let f = 0; f < count; f++) {
    drawScene(ctx, size, f / count);
    const image = ctx.getImageData(0, 0, size, size);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (random() + random() + random() - 1.5) * 6;
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n;
    }
    frames.push(rgbaToI420(d, size, size));
  }
  return { frames, size, durationMs: seconds * 1000, takes: [seconds * 1000], raw: null, audio: null, sample: true };
}
