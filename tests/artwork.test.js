import test from "node:test";
import assert from "node:assert/strict";
import { artworkLayout } from "../src/artwork.js";

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${actual} should be within ${tolerance} of ${expected}`);
}

test("native die-cut layout preserves small artwork and adds equal transparent guards", () => {
  const result = artworkLayout(601, 401, { size: 3, border: 0 });
  assert.equal(result.scale, 1);
  assert.equal(result.radius, 0);
  assert.equal(result.bodyWidth, 601);
  assert.equal(result.bodyHeight, 401);
  assert.equal(result.width, 605);
  assert.equal(result.height, 405);
  assert.equal(result.x, 2);
  assert.equal(result.y, 2);
  near(result.dpi, 605 / 3);
});

test("outline allowance splits evenly around the silhouette and retains a guard beyond its antialias band", () => {
  for (const border of [1, 8, 15]) {
    const result = artworkLayout(601, 401, { size: 4, border });
    near(2 * result.radius / (601 + 2 * result.radius), border / 100);
    near(result.x, (result.width - result.bodyWidth) / 2);
    near(result.y, (result.height - result.bodyHeight) / 2);
    assert.ok(result.x - result.radius >= 2);
    assert.ok(result.y - result.radius >= 2);
    assert.equal(result.bodyWidth, 601);
    assert.equal(result.bodyHeight, 401);
  }
});

test("native exports reach the print target by downsampling large photos without enlarging small photos", () => {
  for (const shape of ["die-cut", "circle", "oval"]) {
    for (const border of [0, 8, 15]) {
      for (const dimensions of [[120, 80], [1600, 900], [3200, 2000]]) {
        const result = artworkLayout(...dimensions, { size: 3, shape, border });
        assert.ok(result.scale > 0 && result.scale <= 1);
        assert.ok(result.bodyWidth <= dimensions[0] + 0.5);
        assert.ok(result.bodyHeight <= dimensions[1] + 0.5);
        assert.ok(Math.max(result.width, result.height) <= 3 * 300 + 2);
        near(result.dpi, Math.max(result.width, result.height) / 3);
      }
    }
  }
});

test("circle and oval artwork stay centered after the native scale is capped", () => {
  for (const shape of ["circle", "oval"]) {
    for (const [width, height] of [[1, 1], [2, 3], [900, 600], [1000, 1400]]) {
      for (const border of [0, 8, 15]) {
        const result = artworkLayout(width, height, { shape, size: 12, border });
        near(result.bodyWidth, width * result.scale);
        near(result.bodyHeight, height * result.scale);
        near(result.x + width * result.scale / 2, result.width / 2);
        near(result.y + height * result.scale / 2, result.height / 2);
        const rx = result.width / 2 - 2 - result.radius;
        const ry = result.height / 2 - 2 - result.radius;
        assert.ok((result.bodyWidth / (2 * rx)) ** 2 +
          (result.bodyHeight / (2 * ry)) ** 2 <= 1 + 1e-9,
        "the inner ellipse should retain every source-image corner");
      }
    }
  }
});

test("preview enlargement is explicit while native physical-size changes adjust density", () => {
  const native8 = artworkLayout(601, 401, { border: 0, size: 8 });
  const native12 = artworkLayout(601, 401, { border: 0, size: 12 });
  assert.equal(native8.width, native12.width);
  assert.equal(native8.height, native12.height);
  near(native8.dpi * 8, native12.dpi * 12);
  assert.ok(artworkLayout(120, 80, { preview: true }).scale > 1);
  assert.equal(artworkLayout(120, 80).scale, 1);
});

test("unsupported physical dimensions and outlines are rejected before allocation", () => {
  for (const dimensions of [[0, 1], [1, 0], [-1, 1], [NaN, 1], [1, Infinity]])
    assert.throws(() => artworkLayout(...dimensions));
  for (const options of [{ size: 0 }, { size: 25 }, { border: -1 },
    { border: 16 }, { border: NaN }, { shape: "unknown" }])
    assert.throws(() => artworkLayout(601, 401, options));
});
