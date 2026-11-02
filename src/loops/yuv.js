// BT.709 limited-range conversion between RGBA and I420, plus luma PSNR.
// The recorder stores I420 so frames take half the memory of RGBA and can
// be handed straight to WebCodecs and compared with decoded output.

export const COLOR_SPACE = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };

export function i420Size(width, height) {
  return width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
}

/** RGBA (Uint8ClampedArray / Uint8Array) to a new I420 buffer. */
export function rgbaToI420(rgba, width, height, out = new Uint8Array(i420Size(width, height))) {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const uBase = width * height;
  const vBase = uBase + cw * ch;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[y * width + x] = Math.round(16 + 0.1826 * rgba[i] + 0.6142 * rgba[i + 1] + 0.062 * rgba[i + 2]);
    }
  }
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < 2; dy++) {
        const y = cy * 2 + dy;
        if (y >= height) continue;
        for (let dx = 0; dx < 2; dx++) {
          const x = cx * 2 + dx;
          if (x >= width) continue;
          const i = (y * width + x) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          n++;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      out[uBase + cy * cw + cx] = Math.round(128 - 0.1006 * r - 0.3386 * g + 0.4392 * b);
      out[vBase + cy * cw + cx] = Math.round(128 + 0.4392 * r - 0.3989 * g - 0.0403 * b);
    }
  }
  return out;
}

/** Luma PSNR in dB between two Y planes of equal size. */
export function psnr(a, b, length = Math.min(a.length, b.length)) {
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  const mse = sum / length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
