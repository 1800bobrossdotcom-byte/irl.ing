// Parametric film grain, after AV1's film grain synthesis: instead of
// spending bits on noise, measure how much fine texture the encoder threw
// away, store a few numbers, and add statistically similar grain back on
// playback. The grain is synthesized, and the file says so.
//
// Model (simplified from the AV1 spec / libaom noise_model.c):
//   - strength: residual standard deviation for 8 brightness bands,
//     measured only in flat blocks where the residual is mostly noise;
//   - size: lag-1 spatial correlation of that residual, reproduced by
//     filtering white noise with a [b, 1, b] kernel.

const BANDS = 8;
const BLOCK = 8;

/**
 * Estimate grain from pairs of source / decoded luma planes.
 * Returns null when the clip has too few flat areas to measure.
 */
export function estimateGrain(pairs, width, height, { flatVariance = 9 } = {}) {
  const sum = new Float64Array(BANDS);
  const count = new Float64Array(BANDS);
  let lagProduct = 0;
  let lagEnergy = 0;
  const residual = new Float64Array(BLOCK * BLOCK);
  for (const { source, decoded } of pairs) {
    for (let by = 0; by + BLOCK <= height; by += BLOCK) {
      for (let bx = 0; bx + BLOCK <= width; bx += BLOCK) {
        let mean = 0;
        let sq = 0;
        let rMean = 0;
        for (let y = 0; y < BLOCK; y++) {
          for (let x = 0; x < BLOCK; x++) {
            const i = (by + y) * width + bx + x;
            const d = decoded[i];
            mean += d;
            sq += d * d;
            const r = source[i] - d;
            residual[y * BLOCK + x] = r;
            rMean += r;
          }
        }
        const n = BLOCK * BLOCK;
        mean /= n;
        if (sq / n - mean * mean > flatVariance) continue;
        rMean /= n;
        const band = Math.min(BANDS - 1, Math.floor(mean / (256 / BANDS)));
        for (let y = 0; y < BLOCK; y++) {
          for (let x = 0; x < BLOCK; x++) {
            const r = residual[y * BLOCK + x] - rMean;
            sum[band] += r * r;
            count[band]++;
            lagEnergy += r * r;
            if (x + 1 < BLOCK) lagProduct += r * (residual[y * BLOCK + x + 1] - rMean);
            if (y + 1 < BLOCK) lagProduct += r * (residual[(y + 1) * BLOCK + x] - rMean);
          }
        }
      }
    }
  }
  const total = count.reduce((a, b) => a + b, 0);
  if (total < 64 * 40) return null;
  const strength = Array.from(sum, (s, b) => (count[b] >= 64 ? Math.sqrt(s / count[b]) : null));
  // Fill bands that had no flat blocks from their nearest measured neighbor.
  for (let b = 0; b < BANDS; b++) {
    if (strength[b] !== null) continue;
    let best = null;
    for (let d = 1; d < BANDS && best === null; d++) best = strength[b - d] ?? strength[b + d] ?? null;
    strength[b] = best ?? 0;
  }
  // Each block contributes ~2 neighbor products per residual (right and down).
  const corr = lagEnergy > 0 ? Math.max(0, Math.min(0.7, lagProduct / (2 * lagEnergy * (1 - 1 / BLOCK)))) : 0;
  return {
    strength: strength.map((s) => Math.round(s * 10) / 10),
    corr: Math.round(corr * 100) / 100,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kernel side tap b so that a [b, 1, b] filter gives lag-1 correlation rho. */
export function tapForCorrelation(rho) {
  const r = Math.max(0, Math.min(0.7, rho));
  return r < 1e-4 ? 0 : (1 - Math.sqrt(1 - 2 * r * r)) / (2 * r);
}

/**
 * A tileable square grain template with unit standard deviation.
 * Deterministic for a given seed so every device draws the same grain.
 */
export function grainTemplate(corr, size = 128, seed = 0x1a2b3c4d) {
  const random = mulberry32(seed);
  const white = new Float32Array(size * size);
  for (let i = 0; i < white.length; i += 2) {
    // Box–Muller: two Gaussian samples per pair of uniforms.
    const u = Math.max(1e-12, random());
    const v = random();
    const m = Math.sqrt(-2 * Math.log(u));
    white[i] = m * Math.cos(2 * Math.PI * v);
    if (i + 1 < white.length) white[i + 1] = m * Math.sin(2 * Math.PI * v);
  }
  const b = tapForCorrelation(corr);
  const pass = (src, dx, dy) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const prev = ((y - dy + size) % size) * size + ((x - dx + size) % size);
        const next = ((y + dy) % size) * size + ((x + dx) % size);
        out[y * size + x] = src[y * size + x] + b * (src[prev] + src[next]);
      }
    }
    return out;
  };
  const grain = pass(pass(white, 1, 0), 0, 1);
  let mean = 0;
  for (const g of grain) mean += g;
  mean /= grain.length;
  let variance = 0;
  for (const g of grain) variance += (g - mean) ** 2;
  const scale = 1 / Math.sqrt(variance / grain.length);
  for (let i = 0; i < grain.length; i++) grain[i] = (grain[i] - mean) * scale;
  return grain;
}
