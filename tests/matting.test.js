import test from "node:test";
import assert from "node:assert/strict";
import { refineMatte } from "../src/matting.js";

function photograph(width, height, coverage, foreground = [36, 70, 108], background = [226, 232, 218]) {
  const alpha = new Uint8ClampedArray(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, a = coverage(x, y);
    alpha[i] = a * 255;
    for (let c = 0; c < 3; c++) rgba[4 * i + c] = a * foreground[c] + (1 - a) * background[c];
    rgba[4 * i + 3] = 255;
  }
  return { rgba, alpha, width, height };
}

// A low-resolution saliency baseline: area-average known coverage, then
// bilinearly resize it. Ground truth comes from the independent scene generator.
function coarseBaseline(truth, width, height, factor = 4) {
  const w = width / factor, h = height / factor;
  const coarse = new Float32Array(w * h);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    coarse[Math.floor(y / factor) * w + Math.floor(x / factor)] += truth[y * width + x] / (factor * factor);
  const output = new Uint8ClampedArray(truth.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const gx = Math.max(0, Math.min(w - 1, (x + 0.5) / factor - 0.5));
    const gy = Math.max(0, Math.min(h - 1, (y + 0.5) / factor - 0.5));
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const at = (dx, dy) => coarse[Math.min(h - 1, y0 + dy) * w + Math.min(w - 1, x0 + dx)];
    output[y * width + x] = (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) +
      (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
  }
  return output;
}

function meanError(actual, expected, include = () => true) {
  let error = 0, count = 0;
  for (let i = 0; i < actual.length; i++) if (include(i)) {
    error += Math.abs(actual[i] - expected[i]);
    count++;
  }
  return error / count;
}

function strandScene() {
  return photograph(256, 192, (x, y) => {
    let alpha = x > 70 && x < 173 && y > 65 && y < 178 ? 1 : 0;
    for (let k = 0; k < 10; k++) {
      const center = 29 + k * 3 + 0.001 * (x - 140) ** 2;
      if (x > 60 && x < 181 && Math.abs(y - center) < 0.7) alpha = Math.max(alpha, 0.8);
    }
    return alpha;
  });
}

test("RGB/source-guided refinement lowers known-alpha error and retains more thin fibers", () => {
  const scene = strandScene();
  const baseline = coarseBaseline(scene.alpha, scene.width, scene.height);
  const result = refineMatte({ ...scene, alpha: baseline, strength: 1 });
  assert.ok(meanError(result.alpha, scene.alpha) < meanError(baseline, scene.alpha) * 0.75);
  const strands = (i) => scene.alpha[i] === 204;
  assert.ok(meanError(result.alpha, scene.alpha, strands) < meanError(baseline, scene.alpha, strands) * 0.95);
  // A stronger foreground signal must not come from flooding the background.
  const background = (i) => scene.alpha[i] === 0;
  assert.ok(meanError(result.alpha, scene.alpha, background) < meanError(baseline, scene.alpha, background));
});

test("equal-luminance chromatic boundaries remain visible to RGB guidance", () => {
  const foreground = [220, 60, 100], background = [25, 119, 91];
  const luminance = (color) => color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
  assert.ok(Math.abs(luminance(foreground) - luminance(background)) < 0.1);
  const scene = photograph(128, 64, (x) => x < 61 ? 1 : x === 61 ? 0.45 : 0, foreground, background);
  const baseline = coarseBaseline(scene.alpha, scene.width, scene.height, 8);
  const result = refineMatte({ ...scene, alpha: baseline, strength: 1 });
  assert.ok(meanError(result.alpha, scene.alpha) < meanError(baseline, scene.alpha) * 0.5);
});

test("coefficient upsampling uses original source edges above the 640-pixel work cap", () => {
  const scene = photograph(1280, 64, (x) => x < 633 ? 1 : x === 633 ? 0.35 : 0);
  const baseline = coarseBaseline(scene.alpha, scene.width, scene.height, 8);
  const result = refineMatte({ ...scene, alpha: baseline, strength: 1 });
  assert.ok(meanError(result.alpha, scene.alpha) < meanError(baseline, scene.alpha) * 0.6);
  assert.equal(result.alpha.length, 1280 * 64);
});

test("zero strength is lossless and inputs are not mutated", () => {
  const scene = strandScene();
  const beforeAlpha = scene.alpha.slice(), beforeRGBA = scene.rgba.slice();
  const result = refineMatte({ ...scene, strength: 0 });
  assert.deepEqual(result.alpha, beforeAlpha);
  assert.deepEqual(result.rgba, beforeRGBA);
  assert.notEqual(result.alpha, scene.alpha);
  assert.notEqual(result.rgba, scene.rgba);
  refineMatte(scene);
  assert.deepEqual(scene.alpha, beforeAlpha);
  assert.deepEqual(scene.rgba, beforeRGBA);
});

test("flat image evidence does not blur a mask, and deep foreground/background stay exact", () => {
  const scene = photograph(128, 64, (x) => x < 64 ? 1 : 0, [110, 110, 110], [110, 110, 110]);
  const baseline = coarseBaseline(scene.alpha, scene.width, scene.height);
  assert.deepEqual(refineMatte({ ...scene, alpha: baseline }).alpha, baseline);
  const distinct = photograph(128, 64, (x) => x < 64 ? 1 : 0);
  const result = refineMatte({ ...distinct, cleanup: 1 });
  assert.equal(result.alpha[32 * 128 + 8], 255);
  assert.equal(result.alpha[32 * 128 + 120], 0);
  assert.deepEqual(result.rgba.slice((32 * 128 + 8) * 4, (32 * 128 + 8) * 4 + 4), distinct.rgba.slice((32 * 128 + 8) * 4, (32 * 128 + 8) * 4 + 4));
});

test("foreground-like grass texture cannot create wisps in confidently clear background", () => {
  const scene = photograph(160, 96, (x) => x < 64 ? 1 : 0);
  const baseline = coarseBaseline(scene.alpha, scene.width, scene.height, 8);
  // The intended foreground ends at x=64. Distracting background blades can
  // nevertheless have foreground-like RGB: the segmentation prior must retain
  // its authority unless the user explicitly paints that boundary for recovery.
  for (let y = 0; y < scene.height; y++) for (let x = 64; x < scene.width; x++) {
    const i = y * scene.width + x;
    const foregroundLike = (x + y * 3) % 7 < 3;
    const color = foregroundLike ? [38, 73, 111] : [184, 220, 94];
    for (let c = 0; c < 3; c++) scene.rgba[i * 4 + c] = color[c];
    // Include a nonzero near-clear prior, not only exact zero pixels.
    if (x >= 72 && x < 77) baseline[i] = (x + y) % 6;
  }
  const result = refineMatte({ ...scene, alpha: baseline, strength: 1, cleanup: 0.7 });
  let protectedPixels = 0, addedCoverage = 0;
  for (let i = 0; i < baseline.length; i++) if (baseline[i] <= 5) {
    protectedPixels++;
    addedCoverage += Math.max(0, result.alpha[i] - baseline[i]);
    assert.ok(result.alpha[i] <= baseline[i]);
  }
  assert.ok(protectedPixels > 7000);
  assert.equal(addedCoverage, 0, "zero added background coverage, despite foreground-like texture");
  const region = new Uint8Array(baseline.length).fill(1);
  const painted = refineMatte({ ...scene, alpha: baseline, strength: 1, region });
  assert.ok(painted.alpha.some((value, i) => baseline[i] <= 5 && value > baseline[i]), "explicit painted recovery can expand an uncertain edge");
  const empty = refineMatte({ ...scene, alpha: new Uint8Array(baseline.length), strength: 1, region });
  assert.ok(empty.alpha.every(value => value === 0), "an entirely empty matte cannot spawn a subject");
});

test("region locks are exact for both binary and soft-coverage masks", () => {
  const scene = photograph(128, 64, (x) => x < 61 ? 1 : 0);
  const baseline = coarseBaseline(scene.alpha, scene.width, scene.height, 8);
  for (const coverage of [1, 255]) {
    const region = new Uint8Array(scene.alpha.length);
    for (let i = 0; i < region.length; i++) if (Math.floor(i / scene.width) >= 32) region[i] = coverage;
    const result = refineMatte({ ...scene, alpha: baseline, region, cleanup: 1 });
    for (let i = 0; i < region.length; i++) if (!region[i]) {
      assert.equal(result.alpha[i], baseline[i]);
      assert.deepEqual(result.rgba.slice(i * 4, i * 4 + 4), scene.rgba.slice(i * 4, i * 4 + 4));
    }
    assert.ok(result.alpha.some((value, i) => region[i] && value !== baseline[i]));
  }
});

test("optional background-color cleanup reduces compositing halos and retains original source alpha", () => {
  const foreground = [36, 70, 108], background = [226, 232, 218];
  const scene = photograph(128, 64, (x) => Math.max(0, Math.min(1, (67 - x) / 8)), foreground, background);
  const result = refineMatte({ ...scene, strength: 0, cleanup: 1 });
  let oldError = 0, newError = 0;
  for (let i = 0; i < scene.alpha.length; i++) {
    const alpha = scene.alpha[i] / 255;
    for (let c = 0; c < 3; c++) {
      // Error after compositing on any new background is alpha times the
      // residual foreground-color error; the new background cancels out.
      oldError += alpha * Math.abs(scene.rgba[i * 4 + c] - foreground[c]);
      newError += alpha * Math.abs(result.rgba[i * 4 + c] - foreground[c]);
    }
    assert.equal(result.rgba[i * 4 + 3], scene.rgba[i * 4 + 3]);
  }
  assert.ok(newError < oldError * 0.5, `halo error ${oldError} → ${newError}`);
  assert.deepEqual(result.alpha, scene.alpha, "cleanup alone must not change coverage");
  for (let i = 0; i < scene.alpha.length; i++) scene.rgba[i * 4 + 3] = scene.alpha[i];
  const transparent = refineMatte({ ...scene, cleanup: 1 });
  for (let i = 0; i < scene.alpha.length; i++) {
    assert.equal(transparent.rgba[i * 4 + 3], scene.rgba[i * 4 + 3]);
    if (scene.rgba[i * 4 + 3] !== 255)
      assert.deepEqual(transparent.rgba.slice(i * 4, i * 4 + 4), scene.rgba.slice(i * 4, i * 4 + 4));
  }
});

test("refinement rejects mismatched dimensions and invalid numerical settings", () => {
  const valid = { rgba: Uint8Array.of(40, 70, 90, 255), alpha: Uint8Array.of(128), width: 1, height: 1 };
  assert.deepEqual([...refineMatte(valid).alpha], [...valid.alpha]);
  for (const change of [{ width: 0 }, { height: -1 }, { width: 1.2 }, { width: 2 }, { region: new Uint8Array(2) }, { radius: NaN }, { strength: Infinity }])
    assert.throws(() => refineMatte({ ...valid, ...change }), /dimensions|settings/);
});
