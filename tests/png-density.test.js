import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";
import { setPngDensity } from "../src/png-density.js";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Independent bitwise CRC implementation checks the generated metadata.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data = Buffer.alloc(0)) {
  const payload = Buffer.concat([Buffer.from(type), data]), bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); payload.copy(bytes, 4); bytes.writeUInt32BE(crc32(payload), bytes.length - 4);
  return bytes;
}
const pixels = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 0, 255, 255, 121, 67, 34, 19]);
function fixture({ before = [], after = [], header, data = true, end = true } = {}) {
  const ihdr = header || Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), ...before, ...(data ? [chunk("IDAT", deflateSync(pixels))] : []), ...after, ...(end ? [chunk("IEND")] : [])]);
}
function chunks(bytes) {
  const copy = Buffer.from(bytes), result = [];
  for (let offset = 8; offset < copy.length;) {
    const length = copy.readUInt32BE(offset), end = offset + length + 12;
    const type = copy.toString("ascii", offset + 4, offset + 8), data = copy.subarray(offset + 8, end - 4);
    assert.equal(copy.readUInt32BE(end - 4), crc32(copy.subarray(offset + 4, end - 4)), `${type} checksum`);
    result.push({ type, data, bytes: copy.subarray(offset, end) }); offset = end;
  }
  return result;
}
function density(x, y, unit) { const bytes = Buffer.alloc(9); bytes.writeUInt32BE(x); bytes.writeUInt32BE(y, 4); bytes[8] = unit; return chunk("pHYs", bytes); }

test("adds square-pixel density immediately after IHDR with valid chunk checksums", () => {
  const original = fixture(), before = original.slice(), output = setPngDensity(original, 300), result = chunks(output);
  assert.equal(output.constructor, Uint8Array);
  assert.deepEqual(original, before);
  assert.notEqual(output.buffer, original.buffer);
  assert.deepEqual(result.map(c => c.type), ["IHDR", "pHYs", "IDAT", "IEND"]);
  assert.equal(result[1].data.readUInt32BE(0), 11811);
  assert.equal(result[1].data.readUInt32BE(4), 11811);
  assert.equal(result[1].data[8], 1);
});

test("replaces every prior density while preserving profiles, image data, and alpha bytes exactly", () => {
  const profile = chunk("iCCP", Buffer.concat([Buffer.from("Test profile\0\0"), deflateSync(Buffer.from("unchanged profile bytes"))]));
  const text = chunk("tEXt", Buffer.from("Author\0Irl'ing"));
  const original = fixture({ before: [profile, density(17, 31, 0), density(6000, 6000, 1)], after: [text] });
  const output = chunks(setPngDensity(original, 220.3)), source = chunks(original);
  assert.equal(output.filter(c => c.type === "pHYs").length, 1);
  assert.equal(output.find(c => c.type === "pHYs").data.readUInt32BE(0), Math.round(220.3 / .0254));
  assert.deepEqual(output.filter(c => c.type !== "pHYs").map(c => c.bytes), source.filter(c => c.type !== "pHYs").map(c => c.bytes));
  assert.deepEqual(inflateSync(Buffer.concat(output.filter(c => c.type === "IDAT").map(c => c.data))), pixels);
});

test("supports typed-array views without using bytes outside the image", () => {
  const original = fixture(), surrounded = Buffer.concat([Buffer.alloc(7, 41), original, Buffer.alloc(5, 42)]);
  const image = new Uint8Array(surrounded.buffer, surrounded.byteOffset + 7, original.length);
  assert.deepEqual(setPngDensity(image, 72), setPngDensity(original, 72));
});

test("density changes are repeatable and never duplicate metadata", () => {
  const first = setPngDensity(fixture(), 300), second = setPngDensity(first, 300);
  assert.deepEqual(first, second);
  const updated = chunks(setPngDensity(second, 144));
  assert.equal(updated.filter(c => c.type === "pHYs").length, 1);
  assert.equal(updated.find(c => c.type === "pHYs").data.readUInt32BE(0), Math.round(144 / .0254));
});

test("rejects unsupported density, damaged signatures, truncated chunks, and corrupt checksums", () => {
  for (const dpi of [0, -1, .9, 9601, Infinity, NaN, "300", null]) assert.throws(() => setPngDensity(fixture(), dpi), /density/i);
  for (const bytes of [null, [], new Uint8Array(8), fixture().subarray(0, 6), fixture().subarray(0, -1)]) assert.throws(() => setPngDensity(bytes, 300));
  const damaged = fixture(); damaged[41] ^= 1;
  assert.throws(() => setPngDensity(damaged, 300), /damaged/i);
  const excessive = fixture(); excessive.writeUInt32BE(0xffffffff, 33);
  assert.throws(() => setPngDensity(excessive, 300), /length/i);
});

test("rejects invalid image-header and ending structures", () => {
  assert.throws(() => setPngDensity(fixture({ header: Buffer.alloc(12) }), 300), /header/i);
  const invalid = Buffer.from([0, 0, 0, 0, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  assert.throws(() => setPngDensity(fixture({ header: invalid }), 300), /header/i);
  assert.throws(() => setPngDensity(fixture({ before: [chunk("IHDR", Buffer.alloc(13))] }), 300), /headers/i);
  assert.throws(() => setPngDensity(fixture({ end: false }), 300), /ending/i);
  assert.throws(() => setPngDensity(fixture({ data: false }), 300), /ending/i);
  assert.throws(() => setPngDensity(Buffer.concat([fixture(), Buffer.from([0])]), 300), /ending/i);
  assert.throws(() => setPngDensity(fixture({ end: false, after: [chunk("IEND", Buffer.from([0]))] }), 300), /ending/i);
});
