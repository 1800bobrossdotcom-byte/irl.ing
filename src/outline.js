// Exact separable Euclidean distance transforms (the lower-envelope method of
// Felzenszwalb and Huttenlocher), used only to derive an outward border layer.
// The original artwork alpha is never thresholded, rewritten or returned here.
const MAX_PIXELS = 16_777_216;

function validateDimensions(values, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS)
    throw new Error("Unsupported image dimensions for outline geometry.");
  if (!values || values.length !== width * height)
    throw new Error("Outline pixels must match the image dimensions.");
}

function transformLine(input, output, size, vertices, boundaries) {
  let last = -1;
  for (let q = 0; q < size; q++) {
    // Empty rows/columns contain Infinity. Excluding absent parabolas avoids
    // Infinity − Infinity intersections without manufacturing a distant seed.
    if (!Number.isFinite(input[q])) continue;
    let intersection = -Infinity;
    while (last >= 0) {
      const previous = vertices[last];
      intersection = ((input[q] + q * q) - (input[previous] + previous * previous)) / (2 * (q - previous));
      if (intersection > boundaries[last]) break;
      last--;
    }
    last++;
    vertices[last] = q;
    boundaries[last] = last ? intersection : -Infinity;
    boundaries[last + 1] = Infinity;
  }
  if (last < 0) {
    output.fill(Infinity, 0, size);
    return;
  }
  let envelope = 0;
  for (let q = 0; q < size; q++) {
    while (envelope < last && boundaries[envelope + 1] < q) envelope++;
    const seed = vertices[envelope];
    output[q] = (q - seed) * (q - seed) + input[seed];
  }
}

/**
 * Squared Euclidean distance between each pixel center and the nearest nonzero
 * seed. Runs in O(width × height) time; empty support returns all Infinity.
 * Float32 storage is exact for integer squared distances in the app's normal
 * capped source dimensions. Inputs are read-only.
 */
export function squaredDistanceTransform(binary, width, height) {
  validateDimensions(binary, width, height);
  const result = new Float32Array(binary.length);
  let hasSeed = false;
  for (const value of binary) if (value) { hasSeed = true; break; }
  if (!hasSeed) {
    result.fill(Infinity);
    return result;
  }
  const horizontal = new Float32Array(binary.length);
  const longest = Math.max(width, height);
  const input = new Float64Array(longest);
  const output = new Float64Array(longest);
  const vertices = new Int32Array(longest);
  const boundaries = new Float64Array(longest + 1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) input[x] = binary[row + x] ? 0 : Infinity;
    transformLine(input, output, width, vertices, boundaries);
    for (let x = 0; x < width; x++) horizontal[row + x] = output[x];
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) input[y] = horizontal[y * width + x];
    transformLine(input, output, height, vertices, boundaries);
    for (let y = 0; y < height; y++) result[y * width + x] = output[y];
  }
  return result;
}

function removeSmallComponents(seeds, width, height, minimum, queue) {
  for (let start = 0; start < seeds.length; start++) {
    if (seeds[start] !== 1) continue;
    let head = 0, tail = 1;
    queue[0] = start;
    seeds[start] = 2;
    while (head < tail) {
      const index = queue[head++], x = index % width, y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (seeds[next] !== 1) continue;
        seeds[next] = 2;
        queue[tail++] = next;
      }
    }
    if (tail < minimum) for (let i = 0; i < tail; i++) seeds[queue[i]] = 0;
  }
}

function fillEnclosedHoles(seeds, width, height, queue) {
  const outside = new Uint8Array(seeds.length);
  let head = 0, tail = 0;
  const enqueue = index => {
    if (!seeds[index] && !outside[index]) {
      outside[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) {
    const index = queue[head++], x = index % width, y = Math.floor(index / width);
    if (x) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
  for (let i = 0; i < seeds.length; i++) if (!seeds[i] && !outside[i]) seeds[i] = 1;
}

/**
 * Return a separate antialiased outward outline layer, including its support.
 * Composite the untouched original artwork above this layer. threshold affects
 * only geometric seeds, so low-alpha hair and source edges remain in artwork.
 * radius uses Euclidean pixel-center distance; coverage is
 * clamp(radius + 0.5 − distance, 0, 1). radius=0 returns no outline.
 *
 * Default behavior retains islands and enclosed holes. An offset naturally
 * closes a gap narrower than its radius; fillHoles explicitly fills enclosed
 * background first. Optional minComponentSize removes smaller 8-connected
 * islands from the border seeds only (default 0 keeps every supported feature).
 * Hole detection uses 4-connected background. Padding is the caller's job:
 * add at least ceil(radius)+2 transparent pixels to avoid clipping at the edge.
 */
export function createOutline(alpha, width, height, {
  radius = 0,
  threshold = 128,
  fillHoles = false,
  minComponentSize = 0,
} = {}) {
  validateDimensions(alpha, width, height);
  if (!Number.isFinite(radius) || radius < 0)
    throw new Error("Outline radius must be a finite nonnegative number.");
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 255)
    throw new Error("Outline threshold must be greater than zero and at most 255.");
  if (!Number.isInteger(minComponentSize) || minComponentSize < 0)
    throw new Error("Outline component size must be a nonnegative integer.");
  const result = new Uint8ClampedArray(alpha.length);
  if (radius === 0) return result;
  const seeds = Uint8Array.from(alpha, value => value >= threshold ? 1 : 0);
  const queue = fillHoles || minComponentSize > 1 ? new Int32Array(alpha.length) : null;
  if (minComponentSize > 1) removeSmallComponents(seeds, width, height, minComponentSize, queue);
  if (fillHoles) fillEnclosedHoles(seeds, width, height, queue);
  const squaredDistances = squaredDistanceTransform(seeds, width, height);
  for (let i = 0; i < result.length; i++) {
    result[i] = seeds[i] ? 255 : Math.max(0, Math.min(1, radius + 0.5 - Math.sqrt(squaredDistances[i]))) * 255;
  }
  return result;
}
