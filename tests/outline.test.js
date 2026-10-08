import test from "node:test";
import assert from "node:assert/strict";
import { createOutline, squaredDistanceTransform } from "../src/outline.js";

test("distance transform agrees with independently enumerated Euclidean distances", () => {
  const width = 14, height = 11;
  const seeds = [[1, 2], [7, 1], [12, 9], [4, 8]];
  const binary = new Uint8Array(width * height);
  for (const [x, y] of seeds) binary[y * width + x] = 1;
  const original = binary.slice();
  const distances = squaredDistanceTransform(binary, width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const expected = Math.min(...seeds.map(([sx, sy]) => (x - sx) ** 2 + (y - sy) ** 2));
    assert.equal(distances[y * width + x], expected);
  }
  assert.deepEqual(binary, original);
});

test("empty seed support stays infinite and produces no border", () => {
  const alpha = new Uint8ClampedArray(63);
  assert.ok(squaredDistanceTransform(alpha, 9, 7).every(value => value === Infinity));
  assert.ok(createOutline(alpha, 9, 7, { radius: 20 }).every(value => value === 0));
  assert.ok(createOutline(alpha, 9, 7, { radius: 20, fillHoles: true }).every(value => value === 0));
});

test("single-pixel and one-dimensional inputs use true squared distance", () => {
  assert.deepEqual([...squaredDistanceTransform(Uint8Array.of(255), 1, 1)], [0]);
  assert.deepEqual([...squaredDistanceTransform(Uint8Array.of(0, 0, 1, 0, 0), 5, 1)], [4, 1, 0, 1, 4]);
  assert.deepEqual([...squaredDistanceTransform(Uint8Array.of(0, 0, 1, 0, 0), 1, 5)], [4, 1, 0, 1, 4]);
});

test("offset coverage is symmetric and respects Euclidean axis/diagonal distances", () => {
  const side = 21, center = 10, alpha = new Uint8ClampedArray(side * side);
  alpha[center * side + center] = 255;
  const result = createOutline(alpha, side, side, { radius: 5 });
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    assert.equal(result[y * side + x], result[(side - 1 - y) * side + x]);
    assert.equal(result[y * side + x], result[y * side + side - 1 - x]);
    assert.equal(result[y * side + x], result[x * side + y]);
  }
  const at = (dx, dy) => result[(center + dy) * side + center + dx];
  assert.equal(at(5, 0), at(3, 4), "equal Euclidean radius gives equal outline coverage");
  assert.equal(at(5, 0), 128);
  assert.equal(at(6, 0), 0);
  assert.equal(at(0, 0), 255);
  const diagonal = createOutline(alpha, side, side, { radius: 1.5 });
  assert.equal(diagonal[(center + 1) * side + center + 1], Math.round((2 - Math.sqrt(2)) * 255));
});

test("fractional radii produce a continuous one-pixel antialias band", () => {
  const alpha = new Uint8ClampedArray(81); alpha[40] = 255;
  const smaller = createOutline(alpha, 9, 9, { radius: 2.1 });
  const larger = createOutline(alpha, 9, 9, { radius: 2.25 });
  assert.equal(larger[4 * 9 + 6], 191);
  assert.ok(larger[4 * 9 + 6] > smaller[4 * 9 + 6]);
  assert.equal(larger[4 * 9 + 7], 0);
  assert.ok(larger.some(value => value > 0 && value < 255));
});

test("radius zero omits the outline without thresholding or mutating artwork alpha", () => {
  const alpha = Uint8ClampedArray.of(0, 3, 80, 127, 128, 192, 255);
  const original = alpha.slice();
  assert.ok(createOutline(alpha, 7, 1, { radius: 0 }).every(value => value === 0));
  const border = createOutline(alpha, 7, 1, { radius: 0.25 });
  assert.equal(border[3], 0, "a low-alpha source pixel is not made an opaque seed");
  assert.equal(border[4], 255, "default threshold applies only to separate geometry");
  assert.deepEqual(alpha, original, "the original fractional hair alpha stays intact");
  const lowerThreshold = createOutline(alpha, 7, 1, { radius: 0.25, threshold: 80 });
  assert.equal(lowerThreshold[2], 255);
  assert.deepEqual(alpha, original);
});

test("holes remain unless an offset reaches them or fillHoles is explicitly enabled", () => {
  const side = 13, alpha = new Uint8ClampedArray(side * side);
  for (let y = 2; y <= 10; y++) for (let x = 2; x <= 10; x++)
    if (x < 4 || x > 8 || y < 4 || y > 8) alpha[y * side + x] = 255;
  const center = 6 * side + 6;
  assert.equal(createOutline(alpha, side, side, { radius: 1 })[center], 0);
  assert.equal(createOutline(alpha, side, side, { radius: 1, fillHoles: true })[center], 255);
  assert.equal(createOutline(alpha, side, side, { radius: 4 })[center], 255);
  assert.equal(createOutline(alpha, side, side, { radius: 1, fillHoles: true })[0], 0, "outside background is not an enclosed hole");
});

test("optional island filtering affects border seeds while preserving tiny original features", () => {
  const side = 16, alpha = new Uint8ClampedArray(side * side);
  alpha[1 * side + 1] = 255;
  alpha[3 * side + 2] = 100; // Faint unrelated halo is not a default seed.
  for (let y = 8; y < 13; y++) for (let x = 8; x < 13; x++) alpha[y * side + x] = 255;
  const original = alpha.slice();
  assert.equal(createOutline(alpha, side, side, { radius: 1 })[1 * side + 1], 255, "small supported features remain by default");
  const cleaned = createOutline(alpha, side, side, { radius: 1, minComponentSize: 2 });
  assert.equal(cleaned[1 * side + 1], 0);
  assert.equal(cleaned[8 * side + 8], 255);
  assert.deepEqual(alpha, original);
  alpha[2 * side + 2] = 255;
  assert.equal(createOutline(alpha, side, side, { radius: 1, minComponentSize: 2 })[1 * side + 1], 255, "diagonally connected hairs form one component");
});

test("outline geometry rejects malformed dimensions and options", () => {
  const alpha = new Uint8Array(4);
  for (const [width, height] of [[0, 4], [2, 0], [1.5, 2], [3, 2], [-1, 4]]) {
    assert.throws(() => squaredDistanceTransform(alpha, width, height), /dimensions/);
    assert.throws(() => createOutline(alpha, width, height), /dimensions/);
  }
  for (const options of [{ radius: -1 }, { radius: Infinity }, { threshold: 0 }, { threshold: 256 }, { minComponentSize: -1 }, { minComponentSize: 1.5 }])
    assert.throws(() => createOutline(alpha, 2, 2, options), /radius|threshold|component/);
});
