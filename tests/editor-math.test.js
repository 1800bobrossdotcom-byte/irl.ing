import test from "node:test";
import assert from "node:assert/strict";
import {
  viewportTransform,
  viewToSource,
  sourceToView,
  strokeDabs,
  brushCoverage,
} from "../src/editor-math.js";

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} should be within ${tolerance} of ${expected}`,
  );
}

test("fit centers portrait and landscape images without altering aspect ratio", () => {
  assert.deepEqual(viewportTransform(1600, 900, 700, 420), {
    scale: 0.4375,
    x: 0,
    y: 13.125,
  });
  assert.deepEqual(viewportTransform(900, 1600, 700, 420), {
    scale: 0.2625,
    x: 231.875,
    y: 0,
  });
});

test("source coordinates round-trip exactly through arbitrary zoom and pan", () => {
  for (const zoom of [1, 2, 8]) {
    const transform = viewportTransform(1599, 1067, 353, 271, zoom, {
      x: 143.25,
      y: -85.125,
    });
    for (const p of [
      { x: 0, y: 0 },
      { x: 352.125, y: 921.875 },
      { x: 1598.75, y: 1066.75 },
    ]) {
      const restored = viewToSource(
        sourceToView(p, transform),
        transform,
        1599,
        1067,
      );
      assert.ok(restored);
      near(restored.x, p.x);
      near(restored.y, p.y);
    }
  }
});

test("pointer events outside the photo are rejected rather than clamped", () => {
  const transform = viewportTransform(600, 400, 600, 400, 2, {
    x: 40,
    y: -20,
  });
  for (const p of [
    { x: -0.01, y: 20 },
    { x: 600, y: 20 },
    { x: 20, y: -0.01 },
    { x: 20, y: 400 },
  ])
    assert.equal(
      viewToSource(sourceToView(p, transform), transform, 600, 400),
      null,
    );
  assert.equal(
    viewToSource({ x: NaN, y: 20 }, transform, 600, 400),
    null,
  );
});

test("one-pixel brushes and fast pointer moves receive continuous source-space dabs", () => {
  const from = { x: 31.125, y: 17.375 };
  const to = { x: 146.625, y: 302.25 };
  for (const diameter of [1, 2, 7, 35]) {
    const dabs = strokeDabs(from, to, diameter);
    assert.deepEqual(dabs.at(-1), to);
    assert.notDeepEqual(dabs[0], from);
    let previous = from;
    for (const dab of dabs) {
      assert.ok(
        Math.hypot(dab.x - previous.x, dab.y - previous.y) <=
          Math.max(0.5, diameter * 0.12) + 1e-9,
      );
      previous = dab;
    }
  }
  assert.deepEqual(strokeDabs(null, to, 1), [to]);
  assert.deepEqual(strokeDabs(to, to, 1), [to]);
});

test("soft brush coverage has a solid core and a smooth monotonic translucent edge", () => {
  assert.equal(brushCoverage(0, 10, 0.5), 1);
  assert.equal(brushCoverage(5, 10, 0.5), 1);
  assert.equal(brushCoverage(7.5, 10, 0.5), 0.5);
  assert.equal(brushCoverage(10, 10, 0.5), 0);
  assert.equal(brushCoverage(12, 10, 0.5), 0);
  let previous = 1;
  for (let distance = 0; distance <= 10; distance += 0.1) {
    const coverage = brushCoverage(distance, 10, 0);
    assert.ok(coverage >= 0 && coverage <= previous);
    previous = coverage;
  }
  // Both transitions approach their boundaries with a flat slope.
  assert.ok(1 - brushCoverage(5.001, 10, 0.5) < 1e-6);
  assert.ok(brushCoverage(9.999, 10, 0.5) < 1e-6);
});

test("hardness one paints a hard disc while degenerate radii paint nothing", () => {
  assert.equal(brushCoverage(9.999, 10, 1), 1);
  assert.equal(brushCoverage(10, 10, 1), 0);
  assert.equal(brushCoverage(0, 0, 1), 0);
  assert.equal(brushCoverage(0, -2, 0), 0);
  assert.equal(brushCoverage(NaN, 10, 0), 0);
  assert.equal(brushCoverage(5, 10, 2), 1);
  assert.equal(brushCoverage(5, 10, -1), 0.5);
});
