// A six-second test scene drawn in code, so the lab works without a camera:
// a low sun sliding over a moving sea, a passing gull and a bobbing buoy.

import { CAPTURE_FPS, CAPTURE_SIZE } from "./loop-recorder.js";

export function sampleClip(seconds = 6) {
  const size = CAPTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const frames = [];
  const count = seconds * CAPTURE_FPS;
  for (let f = 0; f < count; f++) {
    const t = f / count;
    const sky = ctx.createLinearGradient(0, 0, 0, size * 0.62);
    sky.addColorStop(0, "#2a3f73");
    sky.addColorStop(0.6, "#e0795a");
    sky.addColorStop(1, "#f6c46b");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#fff1b8";
    ctx.beginPath();
    ctx.arc(size * (0.3 + 0.4 * t), size * (0.5 - 0.12 * Math.sin(Math.PI * t)), size * 0.11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1d4b5c";
    ctx.fillRect(0, size * 0.62, size, size);
    for (let row = 0; row < 9; row++) {
      const y = size * (0.64 + row * 0.042);
      ctx.strokeStyle = row % 2 ? "#3f8191" : "#f0a36d";
      ctx.lineWidth = 1.5 + row * 0.35;
      ctx.beginPath();
      for (let x = 0; x <= size; x += 4) {
        const wave = Math.sin(x * 0.09 + row * 1.7 + t * Math.PI * 4) * (1.5 + row * 0.4);
        if (x === 0) ctx.moveTo(x, y + wave);
        else ctx.lineTo(x, y + wave);
      }
      ctx.stroke();
    }
    const by = size * 0.74 + Math.sin(t * Math.PI * 6) * 3;
    ctx.fillStyle = "#ed693d";
    ctx.fillRect(size * 0.7, by - 14, 10, 18);
    ctx.fillStyle = "#fffef9";
    ctx.fillRect(size * 0.7, by - 8, 10, 4);
    const gx = size * (1.1 - 1.3 * t);
    const flap = Math.sin(t * Math.PI * 14) * 5;
    ctx.strokeStyle = "#1b1e24";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(gx - 9, size * 0.28 + flap);
    ctx.lineTo(gx, size * 0.3);
    ctx.lineTo(gx + 9, size * 0.28 + flap);
    ctx.stroke();
    frames.push(ctx.getImageData(0, 0, size, size).data);
  }
  return { frames, durationMs: seconds * 1000, takes: [seconds * 1000], raw: null, audio: null, sample: true };
}
