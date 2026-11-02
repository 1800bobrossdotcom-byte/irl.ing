// Dots codec: a short clip becomes one fixed set of colored dots that
// rearrange themselves. What is stored is not video, only:
//   1. the dot colors (one color per dot, fixed for the whole loop), and
//   2. for each keyframe, a coarse brightness label for every grid cell.
// The decoder rebuilds every dot's path from those labels with a fully
// deterministic integer algorithm, so motion itself costs zero bytes.

export const MAGIC = [0x49, 0x52, 0x4c, 0x44]; // "IRLD"
export const VERSION = 1;
const HEADER_BYTES = 18;
const FLAG_AUDIO = 1;
export const MAX_GRID = 255; // keeps cell indexes inside Uint16

/** Integer Rec. 709 luminance, scaled by 10000. */
export function luminance(r, g, b) {
  return 2126 * r + 7152 * g + 722 * b;
}

/**
 * Area-average an RGBA (or RGB) square image of `size`² into a `grid`²
 * RGB image. Pure and deterministic so Node tests match browsers.
 */
export function resampleSquare(src, size, grid, channels = 4) {
  const out = new Uint8Array(grid * grid * 3);
  const scale = size / grid;
  for (let gy = 0; gy < grid; gy++) {
    const y0 = gy * scale;
    const y1 = y0 + scale;
    for (let gx = 0; gx < grid; gx++) {
      const x0 = gx * scale;
      const x1 = x0 + scale;
      let r = 0;
      let g = 0;
      let b = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy < size; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx < size; sx++) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const i = (sy * size + sx) * channels;
          r += src[i] * w;
          g += src[i + 1] * w;
          b += src[i + 2] * w;
          area += w;
        }
      }
      const o = (gy * grid + gx) * 3;
      out[o] = Math.round(r / area);
      out[o + 1] = Math.round(g / area);
      out[o + 2] = Math.round(b / area);
    }
  }
  return out;
}

/** Start rank of each brightness bucket: bucket b owns ranks [s[b], s[b+1]). */
export function bucketStarts(count, buckets) {
  const starts = new Uint32Array(buckets + 1);
  for (let b = 0; b <= buckets; b++) starts[b] = Math.floor((b * count) / buckets);
  return starts;
}

function bucketOfRank(count, buckets) {
  const starts = bucketStarts(count, buckets);
  const table = new Uint8Array(count);
  for (let b = 0; b < buckets; b++) table.fill(b, starts[b], starts[b + 1]);
  return table;
}

/** Hilbert curve index of (x, y) on an n×n grid, n a power of two. */
export function hilbertIndex(n, x, y) {
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

/** Grid cells in Hilbert order: neighbors on the curve are neighbors in space. */
export function hilbertOrder(grid) {
  let n = 1;
  while (n < grid) n <<= 1;
  const cells = grid * grid;
  const keys = new Float64Array(cells);
  const order = new Uint32Array(cells);
  for (let c = 0; c < cells; c++) {
    keys[c] = hilbertIndex(n, c % grid, Math.floor(c / grid));
    order[c] = c;
  }
  order.sort((a, b) => keys[a] - keys[b]);
  return order;
}

function validate({ grid, buckets, fps }) {
  if (!Number.isInteger(grid) || grid < 2 || grid > MAX_GRID) throw new RangeError(`grid must be 2–${MAX_GRID}`);
  if (!Number.isInteger(buckets) || buckets < 2 || buckets > 256 || buckets > grid * grid)
    throw new RangeError("buckets must be 2–256");
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new RangeError("fps must be 1–60");
}

/**
 * Encode RGB frames (each grid²×3 bytes) into a dots recipe.
 * Each frame's cells are ranked by brightness and split into equal-size
 * buckets, so every frame needs exactly the same number of dots per bucket.
 */
export function encodeFrames(frames, { grid, fps, buckets }) {
  validate({ grid, buckets, fps });
  if (frames.length < 2) throw new RangeError("need at least two frames");
  const cells = grid * grid;
  const rankBucket = bucketOfRank(cells, buckets);
  const sums = new Float64Array(cells * 3);
  const labels = new Uint8Array(frames.length * cells);
  const lum = new Float64Array(cells);
  const order = new Uint32Array(cells);
  frames.forEach((rgb, f) => {
    if (rgb.length !== cells * 3) throw new RangeError("frame size does not match grid");
    for (let c = 0; c < cells; c++) {
      lum[c] = luminance(rgb[c * 3], rgb[c * 3 + 1], rgb[c * 3 + 2]);
      order[c] = c;
    }
    order.sort((a, b) => lum[a] - lum[b] || a - b);
    const base = f * cells;
    for (let rank = 0; rank < cells; rank++) {
      const c = order[rank];
      labels[base + c] = rankBucket[rank];
      sums[rank * 3] += rgb[c * 3];
      sums[rank * 3 + 1] += rgb[c * 3 + 1];
      sums[rank * 3 + 2] += rgb[c * 3 + 2];
    }
  });
  // Dot k is the k-th darkest dot; its color is the average color found at
  // brightness rank k across the whole clip.
  const colors = new Uint8Array(cells * 3);
  for (let i = 0; i < colors.length; i++) colors[i] = Math.round(sums[i] / frames.length);
  return { grid, fps, buckets, frameCount: frames.length, colors, labels, audio: null };
}

/**
 * Rebuild where every dot sits on every keyframe.
 * Returns Uint16Array(frameCount × cells): positions[f*cells + dot] = cell.
 * Within a bucket, dots ordered along the Hilbert curve by their previous
 * position fill target cells ordered along the same curve, so nearby dots
 * travel to nearby places and the picture flows instead of shuffling.
 */
export function computePaths(recipe) {
  const { grid, buckets, frameCount, labels } = recipe;
  const cells = grid * grid;
  const starts = bucketStarts(cells, buckets);
  const dotBucket = bucketOfRank(cells, buckets);
  const curve = hilbertOrder(grid);
  const positions = new Uint16Array(frameCount * cells);
  const occupant = new Uint32Array(cells); // cell -> dot on the previous frame
  const cellCursor = new Uint32Array(buckets);
  const dotCursor = new Uint32Array(buckets);
  const bucketCells = new Uint32Array(cells);
  const bucketDots = new Uint32Array(cells);
  for (let f = 0; f < frameCount; f++) {
    const base = f * cells;
    cellCursor.set(starts.subarray(0, buckets));
    for (let i = 0; i < cells; i++) {
      const c = curve[i];
      const b = labels[base + c];
      if (b >= buckets || cellCursor[b] >= starts[b + 1]) throw new Error("corrupt loop: bucket sizes do not match");
      bucketCells[cellCursor[b]++] = c;
    }
    if (f === 0) {
      for (let d = 0; d < cells; d++) bucketDots[d] = d;
    } else {
      dotCursor.set(starts.subarray(0, buckets));
      const prev = base - cells;
      for (let d = 0; d < cells; d++) occupant[positions[prev + d]] = d;
      // Dots are bucketed by color rank, so bucket = rank range of the dot.
      for (let i = 0; i < cells; i++) {
        const d = occupant[curve[i]];
        bucketDots[dotCursor[dotBucket[d]]++] = d;
      }
    }
    for (let i = 0; i < cells; i++) positions[base + bucketDots[i]] = bucketCells[i];
  }
  return positions;
}

/** The still image at one keyframe, as grid²×3 RGB. Used for quality checks. */
export function renderKeyframe(recipe, positions, frame) {
  const cells = recipe.grid * recipe.grid;
  const out = new Uint8Array(cells * 3);
  for (let d = 0; d < cells; d++) {
    const c = positions[frame * cells + d];
    out.set(recipe.colors.subarray(d * 3, d * 3 + 3), c * 3);
  }
  return out;
}

async function pipe(bytes, stream) {
  const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

/** Planar, delta-coded colors and temporally delta-coded labels compress well. */
function packBody({ grid, frameCount, colors, labels }) {
  const cells = grid * grid;
  const body = new Uint8Array(cells * 3 + frameCount * cells);
  for (let ch = 0; ch < 3; ch++) {
    let prev = 0;
    for (let d = 0; d < cells; d++) {
      const v = colors[d * 3 + ch];
      body[ch * cells + d] = (v - prev) & 0xff;
      prev = v;
    }
  }
  const off = cells * 3;
  body.set(labels.subarray(0, cells), off);
  for (let i = cells; i < labels.length; i++) body[off + i] = (labels[i] - labels[i - cells]) & 0xff;
  return body;
}

function unpackBody(body, grid, frameCount) {
  const cells = grid * grid;
  if (body.length !== cells * 3 + frameCount * cells) throw new Error("corrupt loop: unexpected length");
  const colors = new Uint8Array(cells * 3);
  for (let ch = 0; ch < 3; ch++) {
    let prev = 0;
    for (let d = 0; d < cells; d++) {
      prev = (prev + body[ch * cells + d]) & 0xff;
      colors[d * 3 + ch] = prev;
    }
  }
  const off = cells * 3;
  const labels = new Uint8Array(frameCount * cells);
  labels.set(body.subarray(off, off + cells));
  for (let i = cells; i < labels.length; i++) labels[i] = (labels[i - cells] + body[off + i]) & 0xff;
  return { colors, labels };
}

/** Serialize a recipe into the compact .irl binary. */
export async function serialize(recipe) {
  validate(recipe);
  const packed = await pipe(packBody(recipe), new CompressionStream("deflate-raw"));
  const audio = recipe.audio;
  const mime = audio ? new TextEncoder().encode(audio.mime) : new Uint8Array();
  if (mime.length > 255) throw new RangeError("audio type too long");
  const total = HEADER_BYTES + packed.length + (audio ? 5 + mime.length + audio.bytes.length : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, audio ? FLAG_AUDIO : 0);
  view.setUint16(6, recipe.grid, true);
  view.setUint16(8, recipe.buckets, true);
  view.setUint8(10, recipe.fps);
  view.setUint8(11, 0);
  view.setUint16(12, recipe.frameCount, true);
  view.setUint32(14, packed.length, true);
  out.set(packed, HEADER_BYTES);
  if (audio) {
    let at = HEADER_BYTES + packed.length;
    view.setUint8(at, mime.length);
    out.set(mime, at + 1);
    at += 1 + mime.length;
    view.setUint32(at, audio.bytes.length, true);
    out.set(audio.bytes, at + 4);
  }
  return out;
}

/** Parse a .irl binary back into a recipe. Throws on anything malformed. */
export async function parse(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < HEADER_BYTES || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error("not an irl.ing loop");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== VERSION) throw new Error("unsupported loop version");
  const flags = view.getUint8(5);
  const grid = view.getUint16(6, true);
  const buckets = view.getUint16(8, true);
  const fps = view.getUint8(10);
  const frameCount = view.getUint16(12, true);
  const packedLength = view.getUint32(14, true);
  validate({ grid, buckets, fps });
  if (frameCount < 2) throw new Error("corrupt loop: too few frames");
  const end = HEADER_BYTES + packedLength;
  if (end > bytes.length) throw new Error("corrupt loop: truncated");
  const body = await pipe(bytes.subarray(HEADER_BYTES, end), new DecompressionStream("deflate-raw"));
  const { colors, labels } = unpackBody(body, grid, frameCount);
  let audio = null;
  if (flags & FLAG_AUDIO) {
    let at = end;
    const mimeLength = bytes[at];
    const mime = new TextDecoder().decode(bytes.subarray(at + 1, at + 1 + mimeLength));
    at += 1 + mimeLength;
    if (at + 4 > bytes.length) throw new Error("corrupt loop: truncated audio");
    const length = view.getUint32(at, true);
    if (at + 4 + length > bytes.length) throw new Error("corrupt loop: truncated audio");
    audio = { mime, bytes: bytes.slice(at + 4, at + 4 + length) };
  }
  return { grid, fps, buckets, frameCount, colors, labels, audio };
}

/**
 * Pick `fps` keyframes per second from frames captured at `captureFps`.
 */
export function pickKeyframes(count, captureFps, fps) {
  const total = Math.max(2, Math.floor((count * fps) / captureFps));
  const picks = [];
  for (let k = 0; k < total; k++) picks.push(Math.min(count - 1, Math.round((k * captureFps) / fps)));
  return picks;
}
