// Pure numerical operations, shared by the worker and regression tests.
export function normalizePixels(rgba) {
  const length = rgba.length / 4;
  const tensor = new Float32Array(length * 3);
  const mean = [0.485, 0.456, 0.406],
    std = [0.229, 0.224, 0.225];
  let max = 1;
  for (let i = 0; i < rgba.length; i += 4) {
    max = Math.max(max, rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  for (let channel = 0; channel < 3; channel++) {
    for (let i = 0; i < length; i++)
      tensor[channel * length + i] =
        (rgba[i * 4 + channel] / max - mean[channel]) / std[channel];
  }
  return tensor;
}

export function normalizeMask(values) {
  let min = Infinity,
    max = -Infinity;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || max - min < 1e-6)
    throw new Error("No clear subject found. Try tracing the object instead.");
  return Uint8ClampedArray.from(
    values,
    (value) => (255 * (value - min)) / (max - min),
  );
}

export function keepConnectedSubject(alpha, width, height, x, y) {
  const start = Math.floor(y) * width + Math.floor(x);
  if (x < 0 || y < 0 || x >= width || y >= height || alpha[start] < 40)
    return null;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0,
    tail = 1;
  queue[0] = start;
  visited[start] = 1;
  while (head < tail) {
    const i = queue[head++],
      px = i % width,
      py = Math.floor(i / width);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx,
          ny = py + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (!visited[next] && alpha[next] >= 12) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
  }
  return Uint8ClampedArray.from(alpha, (value, i) => (visited[i] ? value : 0));
}
