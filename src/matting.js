// Image-guided matte refinement. This is a deterministic CPU implementation of
// fast RGB guided filtering, not another segmentation model. The coarse mask
// supplies the subject; source-image edges refine its uncertain boundary.
const GRID_EDGE = 640;
const EPSILON = 0.002;
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));

function boundedMatte(candidate, original, painted) {
  candidate = clamp(candidate);
  if (painted || candidate <= original) return candidate;
  // A segmentation prior of near-zero is background evidence. RGB texture in
  // grass/foliage can otherwise extrapolate into false translucent wisps. Global
  // refinement may reduce such pixels, but may not invent foreground there.
  if (original <= 5 / 255) return original;
  // Preserve useful growth in a supported soft strand while limiting how much
  // background an uncertain local color model can promote in a single pass.
  return Math.min(candidate, original + 0.25 * Math.sqrt(original));
}

function boxMean(input, width, height, radius) {
  const horizontal = new Float32Array(input.length);
  const output = new Float32Array(input.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x++) sum += input[row + x];
    for (let x = 0; x < width; x++) {
      const count = Math.min(width - 1, x + radius) - Math.max(0, x - radius) + 1;
      horizontal[row + x] = sum / count;
      if (x - radius >= 0) sum -= input[row + x - radius];
      if (x + radius + 1 < width) sum += input[row + x + radius + 1];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y++) sum += horizontal[y * width + x];
    for (let y = 0; y < height; y++) {
      const count = Math.min(height - 1, y + radius) - Math.max(0, y - radius) + 1;
      output[y * width + x] = sum / count;
      if (y - radius >= 0) sum -= horizontal[(y - radius) * width + x];
      if (y + radius + 1 < height) sum += horizontal[(y + radius + 1) * width + x];
    }
  }
  return output;
}

function workGrid(rgba, alpha, width, height) {
  const scale = Math.min(1, GRID_EDGE / Math.max(width, height));
  const gridWidth = Math.max(1, Math.round(width * scale));
  const gridHeight = Math.max(1, Math.round(height * scale));
  const count = gridWidth * gridHeight;
  const rgb = Array.from({ length: 3 }, () => new Float32Array(count));
  const matte = new Float32Array(count);
  for (let y = 0; y < gridHeight; y++) {
    const y0 = Math.floor(y * height / gridHeight);
    const y1 = Math.floor((y + 1) * height / gridHeight);
    for (let x = 0; x < gridWidth; x++) {
      const x0 = Math.floor(x * width / gridWidth);
      const x1 = Math.floor((x + 1) * width / gridWidth);
      const i = y * gridWidth + x;
      let samples = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const source = sy * width + sx;
          for (let channel = 0; channel < 3; channel++) rgb[channel][i] += rgba[source * 4 + channel];
          matte[i] += alpha[source];
          samples++;
        }
      }
      for (const channel of rgb) channel[i] /= samples * 255;
      matte[i] /= samples * 255;
    }
  }
  return { rgb, matte, width: gridWidth, height: gridHeight };
}

function guidedCoefficients(grid, radius) {
  const { rgb, matte, width, height } = grid;
  const meanRGB = rgb.map((channel) => boxMean(channel, width, height, radius));
  const meanMatte = boxMean(matte, width, height, radius);
  const product = new Float32Array(matte.length);
  const covariance = (left, right, meanLeft, meanRight) => {
    for (let i = 0; i < product.length; i++) product[i] = left[i] * right[i];
    const result = boxMean(product, width, height, radius);
    for (let i = 0; i < result.length; i++) result[i] -= meanLeft[i] * meanRight[i];
    return result;
  };
  const rr = covariance(rgb[0], rgb[0], meanRGB[0], meanRGB[0]);
  const rg = covariance(rgb[0], rgb[1], meanRGB[0], meanRGB[1]);
  const rb = covariance(rgb[0], rgb[2], meanRGB[0], meanRGB[2]);
  const gg = covariance(rgb[1], rgb[1], meanRGB[1], meanRGB[1]);
  const gb = covariance(rgb[1], rgb[2], meanRGB[1], meanRGB[2]);
  const bb = covariance(rgb[2], rgb[2], meanRGB[2], meanRGB[2]);
  // The three cross-covariance buffers become regression coefficients in place.
  const coefficients = rgb.map((channel, c) => covariance(channel, matte, meanRGB[c], meanMatte));
  const intercept = new Float32Array(matte.length);
  const variance = new Float32Array(matte.length);
  for (let i = 0; i < matte.length; i++) {
    variance[i] = Math.max(0, rr[i] + gg[i] + bb[i]);
    const r = Math.max(0, rr[i]) + EPSILON;
    const g = Math.max(0, gg[i]) + EPSILON;
    const b = Math.max(0, bb[i]) + EPSILON;
    const c00 = g * b - gb[i] * gb[i];
    const c01 = rb[i] * gb[i] - rg[i] * b;
    const c02 = rg[i] * gb[i] - rb[i] * g;
    const c11 = r * b - rb[i] * rb[i];
    const c12 = rg[i] * rb[i] - r * gb[i];
    const c22 = r * g - rg[i] * rg[i];
    const determinant = r * c00 + rg[i] * c01 + rb[i] * c02;
    const pr = coefficients[0][i], pg = coefficients[1][i], pb = coefficients[2][i];
    if (determinant > 1e-12 && Number.isFinite(determinant)) {
      coefficients[0][i] = (c00 * pr + c01 * pg + c02 * pb) / determinant;
      coefficients[1][i] = (c01 * pr + c11 * pg + c12 * pb) / determinant;
      coefficients[2][i] = (c02 * pr + c12 * pg + c22 * pb) / determinant;
    } else {
      for (const coefficient of coefficients) coefficient[i] = 0;
    }
    intercept[i] = meanMatte[i] - coefficients.reduce((sum, channel, c) => sum + channel[i] * meanRGB[c][i], 0);
  }
  return {
    coefficients: [...coefficients, intercept].map((channel) => boxMean(channel, width, height, radius)),
    variance,
  };
}

function localColors(grid, radius) {
  const { rgb, matte, width, height } = grid;
  const fg = Float32Array.from(matte, (p) => p >= 0.9 ? p * p : 0);
  const bg = Float32Array.from(matte, (p) => p <= 0.1 ? (1 - p) * (1 - p) : 0);
  const foregroundWeight = boxMean(fg, width, height, radius);
  const backgroundWeight = boxMean(bg, width, height, radius);
  const product = new Float32Array(matte.length);
  const colors = (weights, support) => rgb.map((channel) => {
    for (let i = 0; i < product.length; i++) product[i] = channel[i] * weights[i];
    const mean = boxMean(product, width, height, radius);
    for (let i = 0; i < mean.length; i++) mean[i] = support[i] > 1e-5 ? mean[i] / support[i] : 0;
    return mean;
  });
  return {
    foreground: colors(fg, foregroundWeight),
    background: colors(bg, backgroundWeight),
    foregroundWeight,
    backgroundWeight,
  };
}

function coordinates(sourceSize, targetSize) {
  const lower = new Int32Array(sourceSize);
  const upper = new Int32Array(sourceSize);
  const fraction = new Float32Array(sourceSize);
  for (let i = 0; i < sourceSize; i++) {
    const coordinate = clamp((i + 0.5) * targetSize / sourceSize - 0.5, 0, targetSize - 1);
    lower[i] = Math.floor(coordinate);
    upper[i] = Math.min(targetSize - 1, lower[i] + 1);
    fraction[i] = coordinate - lower[i];
  }
  return { lower, upper, fraction };
}

/**
 * Refine a mask without changing subject identity or source transparency.
 * radius is measured on a work grid capped at 640 px on its longest edge.
 * strength blends the image-guided matte; cleanup optionally removes edge tint.
 * region accepts either binary 0/1 or coverage 0..255 and locks all zero pixels.
 * Returned rgba is a source color image, retaining its original alpha. Render it
 * with the separately returned mask exactly once (do not premultiply it here).
 */
export function refineMatte({ rgba, alpha, width, height, radius = 6, strength = 0.8, cleanup = 0, region = null }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_777_216)
    throw new Error("Unsupported image dimensions for edge refinement.");
  const count = width * height;
  if (!rgba || rgba.length !== count * 4 || !alpha || alpha.length !== count || (region && region.length !== count))
    throw new Error("The image, mask and refinement region must have matching dimensions.");
  if (![radius, strength, cleanup].every(Number.isFinite))
    throw new Error("Edge refinement settings must be finite numbers.");
  radius = Math.round(clamp(radius, 1, 32));
  strength = clamp(strength);
  cleanup = clamp(cleanup);
  const outputAlpha = Uint8ClampedArray.from(alpha);
  const outputRGBA = Uint8ClampedArray.from(rgba);
  if (!strength && !cleanup) return { alpha: outputAlpha, rgba: outputRGBA };
  let regionDivisor = 1;
  if (region) {
    for (const value of region) if (value > 1) { regionDivisor = 255; break; }
  }
  const grid = workGrid(rgba, alpha, width, height);
  const filtered = strength ? guidedCoefficients(grid, radius) : null;
  const foreground = Float32Array.from(grid.matte, (p) => p >= 0.5 ? 1 : 0);
  const nearbyForeground = boxMean(foreground, grid.width, grid.height, radius + 1);
  const unknown = Uint8Array.from(grid.matte, (p, i) =>
    (p > 1 / 255 && p < 254 / 255) || (nearbyForeground[i] > 0.001 && nearbyForeground[i] < 0.999) ? 1 : 0);
  // A larger support window supplies stable interior/exterior color estimates;
  // the guided coefficients still operate at the smaller edge-detail radius.
  const colors = localColors(grid, Math.max(6, radius * 3));
  const xs = coordinates(width, grid.width), ys = coordinates(height, grid.height);
  for (let y = 0; y < height; y++) {
    const row0 = ys.lower[y] * grid.width, row1 = ys.upper[y] * grid.width;
    const fy = ys.fraction[y];
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const gate = region ? clamp(region[i] / regionDivisor) : 1;
      if (!gate) continue;
      const i00 = row0 + xs.lower[x], i10 = row0 + xs.upper[x];
      const i01 = row1 + xs.lower[x], i11 = row1 + xs.upper[x];
      const fx = xs.fraction[x];
      const sample = (field) => (field[i00] * (1 - fx) + field[i10] * fx) * (1 - fy) +
        (field[i01] * (1 - fx) + field[i11] * fx) * fy;
      if (!(unknown[i00] || unknown[i10] || unknown[i01] || unknown[i11])) continue;
      const original = alpha[i] / 255;
      const source = [rgba[i * 4] / 255, rgba[i * 4 + 1] / 255, rgba[i * 4 + 2] / 255];
      if (filtered && sample(filtered.variance) > 1e-5) {
        const q = clamp(sample(filtered.coefficients[3]) +
          source.reduce((sum, color, c) => sum + sample(filtered.coefficients[c]) * color, 0));
        outputAlpha[i] = boundedMatte(original + strength * gate * (q - original), original, Boolean(region)) * 255;
      }
      let refined = outputAlpha[i] / 255;
      // Transparent artwork already contains deliberate source-edge color; do
      // not reinterpret it as a photograph against a removable background.
      if (rgba[i * 4 + 3] !== 255) continue;
      const fw = sample(colors.foregroundWeight), bw = sample(colors.backgroundWeight);
      if (fw < 0.02 || bw < 0.02) continue;
      const f = colors.foreground.map(sample), b = colors.background.map(sample);
      let separation = 0, projection = 0;
      for (let c = 0; c < 3; c++) {
        const difference = f[c] - b[c];
        separation += difference * difference;
        projection += (source[c] - b[c]) * difference;
      }
      if (separation < 0.015) continue;
      const colorAlpha = clamp(projection / separation);
      let residual = 0;
      for (let c = 0; c < 3; c++) residual += (source[c] - (b[c] + colorAlpha * (f[c] - b[c]))) ** 2;
      // A source color on the local F/B color line provides a fractional-alpha
      // observation. This can recover visible fine fibers that a resized mask
      // blurred together, without assigning hard foreground to every RGB edge.
      const colorConfidence = clamp(1 - residual / (0.008 + 0.02 * separation)) *
        Math.min(1, fw / 0.1, bw / 0.1);
      if (strength) {
        refined = boundedMatte(refined + strength * gate * 0.7 * colorConfidence *
          clamp(colorAlpha - refined, -0.5, 0.5), original, Boolean(region));
        outputAlpha[i] = refined * 255;
        refined = outputAlpha[i] / 255;
      }
      if (!cleanup || refined <= 0.04 || refined >= 0.96) continue;
      // Color removal is more conservative than alpha refinement: a suspect
      // source/matte mismatch must not introduce an unrelated edge tint.
      const confidence = colorConfidence * clamp(1 - Math.abs(colorAlpha - refined) / 0.4);
      const amount = cleanup * gate * confidence;
      for (let c = 0; c < 3; c++) {
        const estimate = clamp((source[c] - (1 - refined) * b[c]) / Math.max(0.12, refined));
        const correction = clamp(estimate - source[c], -0.3, 0.3);
        outputRGBA[i * 4 + c] = (source[c] + amount * correction) * 255;
      }
    }
  }
  return { alpha: outputAlpha, rgba: outputRGBA };
}
