// A six-second scene drawn in code: a low sun sliding over a moving sea,
// a passing gull and a bobbing buoy. Used for the lab's sample clip and the
// landing page's live loop. t runs 0–1 over the loop.

export function drawScene(ctx, size, t) {
  const k = size / 160;
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
    ctx.lineWidth = (1.5 + row * 0.35) * k;
    ctx.beginPath();
    for (let x = 0; x <= size; x += 4) {
      const wave = Math.sin((x / k) * 0.09 + row * 1.7 + t * Math.PI * 4) * (1.5 + row * 0.4) * k;
      if (x === 0) ctx.moveTo(x, y + wave);
      else ctx.lineTo(x, y + wave);
    }
    ctx.stroke();
  }
  const by = size * 0.74 + Math.sin(t * Math.PI * 6) * 3 * k;
  ctx.fillStyle = "#ed693d";
  ctx.fillRect(size * 0.7, by - 14 * k, 10 * k, 18 * k);
  ctx.fillStyle = "#fffef9";
  ctx.fillRect(size * 0.7, by - 8 * k, 10 * k, 4 * k);
  const gx = size * (1.1 - 1.3 * t);
  const flap = Math.sin(t * Math.PI * 14) * 5 * k;
  ctx.strokeStyle = "#1b1e24";
  ctx.lineWidth = 2.5 * k;
  ctx.beginPath();
  ctx.moveTo(gx - 9 * k, size * 0.28 + flap);
  ctx.lineTo(gx, size * 0.3);
  ctx.lineTo(gx + 9 * k, size * 0.28 + flap);
  ctx.stroke();
}
