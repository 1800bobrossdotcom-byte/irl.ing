// Honest Zoom: upscaling that can never contradict what was sent.
//
// After any upscaler runs, an integer pass adjusts every 2×2 block of the
// upscaled plane so its four values sum to exactly 4 × the received pixel.
// Shrinking the output back down (2×2 box average) therefore returns the
// received frame bit for bit; everything an upscaler adds lives only in what
// the received pixels cannot see. The guarantee holds whatever the upscaler
// is, and anyone holding the received frame can check it.
//
// Planes are 8-bit, as decoded from AV1/VP9/H.264 (I420: full-size Y,
// half-size U and V). This file is the reference implementation: the GPU
// version in finish-gl.js runs the same lock, and tests compare against it.

export const FACTOR = 2;

/** Lock one 2×2 block held in v[0..3] to sum to 4 × target, in place. */
function lockBlock(v, target, start) {
  let diff = 4 * target - (v[0] + v[1] + v[2] + v[3]);
  // Each round spreads the difference over values that can still move; a
  // round either finishes or pins at least one value at 0 or 255, so four
  // rounds always suffice (the target itself, 0–255, is always reachable).
  for (let round = 0; round < 5 && diff !== 0; round++) {
    const up = diff > 0;
    let movable = 0;
    for (let k = 0; k < 4; k++) if (up ? v[k] < 255 : v[k] > 0) movable++;
    if (!movable) break;
    const size = Math.abs(diff);
    const share = Math.floor(size / movable);
    const extra = size - share * movable;
    let m = 0;
    for (let j = 0; j < 4; j++) {
      const k = (start + j) & 3; // rotate who takes the remainder: no fixed pattern
      if (!(up ? v[k] < 255 : v[k] > 0)) continue;
      const add = (share + (m < extra ? 1 : 0)) * (up ? 1 : -1);
      m++;
      const next = Math.min(255, Math.max(0, v[k] + add));
      diff -= next - v[k];
      v[k] = next;
    }
  }
}

/**
 * Lock an upscaled plane (2·srcW × 2·srcH, Uint8) to its source plane, in place.
 */
export function lockPlane(up, src, srcW, srcH) {
  const upW = srcW * FACTOR;
  const v = [0, 0, 0, 0];
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const i = 2 * y * upW + 2 * x;
      v[0] = up[i];
      v[1] = up[i + 1];
      v[2] = up[i + upW];
      v[3] = up[i + upW + 1];
      lockBlock(v, src[y * srcW + x], (x + 2 * y) & 3);
      up[i] = v[0];
      up[i + 1] = v[1];
      up[i + upW] = v[2];
      up[i + upW + 1] = v[3];
    }
  }
  return up;
}

/** Number of 2×2 blocks whose sum is not exactly 4 × the source pixel. */
export function blockMismatches(up, src, srcW, srcH) {
  const upW = srcW * FACTOR;
  let bad = 0;
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const i = 2 * y * upW + 2 * x;
      if (up[i] + up[i + 1] + up[i + upW] + up[i + upW + 1] !== 4 * src[y * srcW + x]) bad++;
    }
  }
  return bad;
}

/** Split an I420 buffer of a square frame into its three planes (views). */
export function planes(i420, size) {
  const c = size / 2;
  return {
    y: i420.subarray(0, size * size),
    u: i420.subarray(size * size, size * size + c * c),
    v: i420.subarray(size * size + c * c, size * size + 2 * c * c),
  };
}

/**
 * Check an upscaled I420 frame (2·size) against its received frame (size).
 * Returns { blocks, mismatched }.
 */
export function verifyFrame(upI420, srcI420, size) {
  const up = planes(upI420, size * FACTOR);
  const src = planes(srcI420, size);
  const c = size / 2;
  const mismatched =
    blockMismatches(up.y, src.y, size, size) + blockMismatches(up.u, src.u, c, c) + blockMismatches(up.v, src.v, c, c);
  return { blocks: size * size + 2 * c * c, mismatched };
}

/** Lock a whole upscaled I420 frame to its received frame, in place. */
export function lockFrame(upI420, srcI420, size) {
  const up = planes(upI420, size * FACTOR);
  const src = planes(srcI420, size);
  const c = size / 2;
  lockPlane(up.y, src.y, size, size);
  lockPlane(up.u, src.u, c, c);
  lockPlane(up.v, src.v, c, c);
  return upI420;
}

// ---- reference upscalers ------------------------------------------------

/** Plain 2× bilinear (pixel-centre aligned), used for color planes. */
export function bilinear2x(src, w, h) {
  const out = new Uint8Array(4 * w * h);
  const W = 2 * w;
  for (let Y = 0; Y < 2 * h; Y++) {
    const sy = Math.min(h - 1, Math.max(0, (Y + 0.5) / 2 - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let X = 0; X < W; X++) {
      const sx = Math.min(w - 1, Math.max(0, (X + 0.5) / 2 - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const top = src[y0 * w + x0] * (1 - fx) + src[y0 * w + x1] * fx;
      const bottom = src[y1 * w + x0] * (1 - fx) + src[y1 * w + x1] * fx;
      out[Y * W + X] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return out;
}

/**
 * 2× edge-adaptive upscale of one plane: a port of AMD FidelityFX FSR 1
 * EASU (MIT; notice in public/third-party-notices.txt) to a single channel.
 */
export function easu2x(src, w, h) {
  const W = 2 * w;
  const out = new Uint8Array(W * 2 * h);
  const at = (x, y) => src[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))] / 255;
  const tap = (acc, offX, offY, dirX, dirY, lenX, lenY, lob, clp, c) => {
    let vx = (offX * dirX + offY * dirY) * lenX;
    let vy = (-offX * dirY + offY * dirX) * lenY;
    const d2 = Math.min(vx * vx + vy * vy, clp);
    let wB = 0.4 * d2 - 1;
    const wA = lob * d2 - 1;
    wB = 1.5625 * wB * wB - 0.5625;
    const weight = wB * wA * wA;
    acc[0] += c * weight;
    acc[1] += weight;
  };
  const set = (acc, w8, lA, lB, lC, lD, lE) => {
    let lenX = 1 / Math.max(Math.abs(lD - lC), Math.abs(lC - lB), 1 / 32768);
    const dirX = lD - lB;
    acc[0] += dirX * w8;
    lenX = Math.min(1, Math.max(0, Math.abs(dirX) * lenX));
    acc[2] += lenX * lenX * w8;
    let lenY = 1 / Math.max(Math.abs(lE - lC), Math.abs(lC - lA), 1 / 32768);
    const dirY = lE - lA;
    acc[1] += dirY * w8;
    lenY = Math.min(1, Math.max(0, Math.abs(dirY) * lenY));
    acc[2] += lenY * lenY * w8;
  };
  const dir = [0, 0, 0];
  const acc = [0, 0];
  for (let Y = 0; Y < 2 * h; Y++) {
    for (let X = 0; X < W; X++) {
      let ppx = (X + 0.5) / 2 - 0.5;
      let ppy = (Y + 0.5) / 2 - 0.5;
      const fx = Math.floor(ppx);
      const fy = Math.floor(ppy);
      ppx -= fx;
      ppy -= fy;
      const b = at(fx, fy - 1), c = at(fx + 1, fy - 1);
      const e = at(fx - 1, fy), f = at(fx, fy), g = at(fx + 1, fy), hh = at(fx + 2, fy);
      const i = at(fx - 1, fy + 1), j = at(fx, fy + 1), k = at(fx + 1, fy + 1), l = at(fx + 2, fy + 1);
      const n = at(fx, fy + 2), o = at(fx + 1, fy + 2);
      // FSR's "luma" is in 0–2; a single plane is its own luma, doubled.
      const L = (v) => v * 2;
      dir[0] = dir[1] = dir[2] = 0;
      set(dir, (1 - ppx) * (1 - ppy), L(b), L(e), L(f), L(g), L(j));
      set(dir, ppx * (1 - ppy), L(c), L(f), L(g), L(hh), L(k));
      set(dir, (1 - ppx) * ppy, L(f), L(i), L(j), L(k), L(n));
      set(dir, ppx * ppy, L(g), L(j), L(k), L(l), L(o));
      let dx = dir[0];
      let dy = dir[1];
      let len = dir[2];
      let r = dx * dx + dy * dy;
      const zero = r < 1 / 32768;
      r = zero ? 1 : 1 / Math.sqrt(r);
      dx = zero ? 1 : dx;
      dx *= r;
      dy *= r;
      len *= 0.5;
      len *= len;
      const stretch = (dx * dx + dy * dy) / Math.max(Math.abs(dx), Math.abs(dy));
      const lenX = 1 + (stretch - 1) * len;
      const lenY = 1 - 0.5 * len;
      const lob = 0.5 + (0.25 - 0.04 - 0.5) * len;
      const clp = 1 / lob;
      acc[0] = acc[1] = 0;
      tap(acc, 0 - ppx, -1 - ppy, dx, dy, lenX, lenY, lob, clp, b);
      tap(acc, 1 - ppx, -1 - ppy, dx, dy, lenX, lenY, lob, clp, c);
      tap(acc, -1 - ppx, 1 - ppy, dx, dy, lenX, lenY, lob, clp, i);
      tap(acc, 0 - ppx, 1 - ppy, dx, dy, lenX, lenY, lob, clp, j);
      tap(acc, 0 - ppx, 0 - ppy, dx, dy, lenX, lenY, lob, clp, f);
      tap(acc, -1 - ppx, 0 - ppy, dx, dy, lenX, lenY, lob, clp, e);
      tap(acc, 1 - ppx, 1 - ppy, dx, dy, lenX, lenY, lob, clp, k);
      tap(acc, 2 - ppx, 1 - ppy, dx, dy, lenX, lenY, lob, clp, l);
      tap(acc, 2 - ppx, 0 - ppy, dx, dy, lenX, lenY, lob, clp, hh);
      tap(acc, 1 - ppx, 0 - ppy, dx, dy, lenX, lenY, lob, clp, g);
      tap(acc, 1 - ppx, 2 - ppy, dx, dy, lenX, lenY, lob, clp, o);
      tap(acc, 0 - ppx, 2 - ppy, dx, dy, lenX, lenY, lob, clp, n);
      const lo = Math.min(f, g, j, k);
      const hi = Math.max(f, g, j, k);
      out[Y * W + X] = Math.round(Math.min(hi, Math.max(lo, acc[0] / acc[1])) * 255);
    }
  }
  return out;
}

/** Reference Honest Zoom of a square I420 frame: EASU luma, bilinear color, then the lock. */
export function honestZoom(srcI420, size) {
  const src = planes(srcI420, size);
  const c = size / 2;
  const S = size * FACTOR;
  const out = new Uint8Array(S * S + 2 * (S / 2) * (S / 2));
  out.set(easu2x(src.y, size, size), 0);
  out.set(bilinear2x(src.u, c, c), S * S);
  out.set(bilinear2x(src.v, c, c), S * S + (S / 2) * (S / 2));
  return lockFrame(out, srcI420, size);
}
