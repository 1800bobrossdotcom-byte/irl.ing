import { squaredDistanceTransform } from "./outline.js";

const previewCache = new WeakMap();
const GUARD = 2;
const clamp = value => Math.max(0, Math.min(1, value));
function canvas(width, height) {
  const result = document.createElement("canvas");
  result.width = width; result.height = height;
  return result;
}

// Border is the total outline allowance as a percentage of the longest edge:
// 8% gives the same 4% allowance on each side. Source pixels are never invented
// by the artwork export; the preview may enlarge them for on-screen inspection.
export function artworkLayout(width, height, { size = 3, border = 8, shape = "die-cut", preview = false } = {}) {
  if (![width, height, size, border].every(Number.isFinite) || width < 1 || height < 1 || size < 1 || size > 24 || border < 0 || border > 15 || !["die-cut", "circle", "oval"].includes(shape))
    throw new Error("Unsupported artwork dimensions or border settings.");
  const allowance = border / 100;
  if (shape === "die-cut") {
    const longest = Math.max(width, height);
    const bodyLongest = preview ? 760 : Math.min(longest, (size * 300 - GUARD * 2) * (1 - allowance));
    const scale = bodyLongest / longest;
    const bodyWidth = Math.max(1, Math.round(width * scale)), bodyHeight = Math.max(1, Math.round(height * scale));
    const radius = Math.max(bodyWidth, bodyHeight) * allowance / (2 * (1 - allowance));
    const padding = Math.ceil(radius) + GUARD;
    const outWidth = bodyWidth + 2 * padding, outHeight = bodyHeight + 2 * padding;
    return { width: outWidth, height: outHeight, bodyWidth, bodyHeight, x: padding, y: padding, radius, scale, dpi: Math.max(outWidth, outHeight) / size };
  }
  const ratio = shape === "oval" ? .75 : 1;
  // Fit the entire image rectangle inside the inner ellipse, rather than
  // clipping photo corners. Both axes use the same source scale.
  const nativeLongest = Math.hypot(width, height / ratio) / (1 - allowance) + GUARD * 2;
  const outWidth = Math.max(8, Math.floor(preview ? 820 : Math.min(size * 300, nativeLongest)));
  const outHeight = Math.max(8, Math.round(outWidth * ratio));
  const rx = outWidth / 2 - GUARD, ry = outHeight / 2 - GUARD;
  const radius = Math.min(rx, ry) * allowance;
  const fit = 1 / Math.hypot(width / (2 * (rx - radius)), height / (2 * (ry - radius)));
  const scale = preview ? fit : Math.min(1, fit);
  return { width: outWidth, height: outHeight, bodyWidth: width * scale, bodyHeight: height * scale, x: (outWidth - width * scale) / 2, y: (outHeight - height * scale) / 2, radius, scale, dpi: outWidth / size };
}

function rasterFrame(image, layout, cache) {
  if (cache && previewCache.has(image)) return previewCache.get(image);
  const maxPadding = Math.ceil(Math.max(layout.bodyWidth, layout.bodyHeight) * .15 / (2 * .85)) + GUARD;
  const frame = canvas(layout.bodyWidth + maxPadding * 2, layout.bodyHeight + maxPadding * 2);
  const ctx = frame.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, maxPadding, maxPadding, layout.bodyWidth, layout.bodyHeight);
  const rgba = ctx.getImageData(0, 0, frame.width, frame.height).data;
  let maxAlpha = 0;
  for (let i = 3; i < rgba.length; i += 4) maxAlpha = Math.max(maxAlpha, rgba[i]);
  const threshold = Math.min(128, maxAlpha);
  const support = new Uint8Array(frame.width * frame.height);
  for (let i = 0; i < support.length; i++) support[i] = rgba[i * 4 + 3] > 0 && rgba[i * 4 + 3] >= threshold ? 1 : 0;
  const distance = squaredDistanceTransform(support, frame.width, frame.height);
  const result = { frame, distance, padding: maxPadding };
  if (cache) previewCache.set(image, result);
  return result;
}

export function renderArtwork(image, options = {}) {
  const layout = artworkLayout(image.width, image.height, options);
  const result = canvas(layout.width, layout.height), ctx = result.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  if ((options.shape || "die-cut") === "die-cut") {
    if (layout.radius > 0) {
      const { frame, distance, padding } = rasterFrame(image, layout, Boolean(options.preview));
      const offset = padding - layout.x;
      const outline = ctx.createImageData(result.width, result.height);
      for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
        const i = y * result.width + x;
        const coverage = clamp(layout.radius + .5 - Math.sqrt(distance[(y + offset) * frame.width + x + offset]));
        outline.data[i * 4] = outline.data[i * 4 + 1] = outline.data[i * 4 + 2] = 255;
        outline.data[i * 4 + 3] = Math.round(coverage * 255);
      }
      ctx.putImageData(outline, 0, 0);
    }
    ctx.drawImage(image, layout.x, layout.y, layout.bodyWidth, layout.bodyHeight);
  } else {
    ctx.beginPath();
    ctx.ellipse(result.width / 2, result.height / 2, result.width / 2 - GUARD, result.height / 2 - GUARD, 0, 0, Math.PI * 2);
    ctx.fillStyle = "white"; ctx.fill();
    ctx.drawImage(image, layout.x, layout.y, image.width * layout.scale, image.height * layout.scale);
  }
  return { canvas: result, layout };
}
