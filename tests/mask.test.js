import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePixels,
  normalizeMask,
  keepConnectedSubject,
} from "../src/mask.js";
import { isValidMoment } from "../src/moments.js";

test("model input uses RGB planar ImageNet normalization", () => {
  const input = normalizePixels(
    Uint8Array.of(255, 0, 128, 255, 0, 255, 255, 255),
  );
  assert.equal(input.length, 6);
  assert.ok(Math.abs(input[0] - (1 - 0.485) / 0.229) < 1e-5);
  assert.ok(Math.abs(input[1] - (0 - 0.485) / 0.229) < 1e-5);
  assert.ok(Math.abs(input[3] - (1 - 0.456) / 0.224) < 1e-5);
});
test("black images yield finite tensors", () => {
  assert.ok([...normalizePixels(new Uint8Array(16))].every(Number.isFinite));
});
test("model mask normalizes independently of its original output range", () => {
  assert.deepEqual(
    [...normalizeMask(Float32Array.of(-2, 0, 2))],
    [0, 128, 255],
  );
  assert.throws(
    () => normalizeMask(Float32Array.of(1, 1, 1)),
    /No clear subject/,
  );
  assert.throws(
    () => normalizeMask(Float32Array.of(NaN, 1)),
    /No clear subject/,
  );
});
test("tap selection retains only the selected connected subject and its soft edge", () => {
  const mask = Uint8Array.of(
    0,
    0,
    0,
    0,
    0,
    255,
    90,
    0,
    255,
    0,
    255,
    20,
    0,
    255,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  assert.deepEqual(
    [...keepConnectedSubject(mask, 5, 4, 0, 1)],
    [0, 0, 0, 0, 0, 255, 90, 0, 0, 0, 255, 20, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(keepConnectedSubject(mask, 5, 4, 2, 0), null);
  assert.equal(keepConnectedSubject(mask, 5, 4, -1, 1), null);
});
test("selection keeps faint feather coverage without following it into another object", () => {
  const alpha = Uint8Array.of(0, 255, 90, 9, 5, 2, 1, 220, 0);
  assert.deepEqual([...keepConnectedSubject(alpha, 9, 1, 1, 0)], [0, 255, 90, 9, 5, 2, 1, 0, 0]);
});
test("saved moments accept local artwork and reject remote or script URLs", () => {
  assert.ok(
    isValidMoment({ id: "1", name: "Flower", data: "/assets/flower.svg" }),
  );
  assert.ok(
    isValidMoment({
      id: "1",
      name: "Photo",
      data: "data:image/png;base64,aGVsbG8=",
    }),
  );
  assert.equal(
    isValidMoment({
      id: "1",
      name: "Bad",
      data: "https://example.com/photo.png",
    }),
    false,
  );
  assert.ok(isValidMoment({ id: "2", name: "Cleaned", data: "/assets/flower.svg", colors: "data:image/png;base64,aGVsbG8=" }));
  assert.equal(isValidMoment({ id: "2", name: "Bad colors", data: "/assets/flower.svg", colors: "https://example.com/photo.png" }), false);
  assert.equal(
    isValidMoment({
      id: "1",
      name: "Bad",
      data: "/assets/flower.svg",
      mask: "javascript:alert(1)",
    }),
    false,
  );
});
