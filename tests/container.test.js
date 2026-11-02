import test from "node:test";
import assert from "node:assert/strict";
import { buildLoop, crc32, frameChunk, parseLoop, readChunks, TYPE, trimLayers, verify } from "../src/loops/container.js";

const FPS = 30;
const GOP = 60;
const meta = { v: 2, codec: "av01.0.04M.08", width: 360, height: 360, fps: FPS, frameCount: 180, gopFrames: GOP, layers: 2 };

/** 180 fake encoded frames, alternating temporal layers, key at each GOP start. */
function fakeFrames() {
  return Array.from({ length: 180 }, (_, i) => ({
    timestamp: Math.round((i * 1e6) / FPS),
    key: i % GOP === 0,
    layer: i % 2,
    data: Uint8Array.from({ length: 200 + (i % 7) * 30 }, (_, j) => (i * 31 + j * 7) & 0xff),
  }));
}

const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
const audio = { mime: "audio/webm;codecs=opus", data: Uint8Array.from({ length: 900 }, (_, i) => i & 0xff) };
const loop = await buildLoop({ meta, frames: fakeFrames(), gopFrames: GOP, audio, keyPair });

function chunkOffsets(bytes) {
  return readChunks(bytes).chunks.map((c) => ({ type: c.type, offset: c.offset, length: c.raw.length, payload: c.payload }));
}

test("a signed loop round-trips every frame, the sound and its signature", async () => {
  const parsed = parseLoop(loop);
  assert.equal(parsed.frames.length, 180);
  assert.deepEqual(parsed.frames.map((f) => f.timestamp), fakeFrames().map((f) => f.timestamp));
  assert.deepEqual(parsed.frames[61].data, fakeFrames()[61].data);
  assert.deepEqual(parsed.audio.data, audio.data);
  assert.deepEqual(parsed.report, { damaged: 0, truncated: false, missingGops: [], gops: 3, layers: 2, layersPresent: 2 });
  const v = await verify(parsed.chunks);
  assert.equal(v.valid, true);
  assert.equal(v.present, v.total);
  assert.equal(v.foreign, 0);
  assert.match(v.id, /^[0-9a-f]{64}$/);
});

test("chunks are written most important first", () => {
  const types = chunkOffsets(loop).map((c) => (c.type === TYPE.VIDEO ? `V${c.payload[2]}` : c.type));
  assert.deepEqual(types, ["META", "SIGN", "V0", "V0", "V0", "AUDI", "V1", "V1", "V1"]);
});

test("a flipped bit costs one chunk, not the loop", async () => {
  const damaged = loop.slice();
  const gop1 = chunkOffsets(loop).find((c) => c.type === TYPE.VIDEO && c.payload[0] === 1 && c.payload[2] === 0);
  damaged[gop1.offset + 40] ^= 0x10;
  const parsed = parseLoop(damaged);
  assert.equal(parsed.report.damaged, 1);
  assert.deepEqual(parsed.report.missingGops, [1]);
  assert.equal(parsed.frames.length, 120, "GOPs 0 and 2 still play in full");
  const v = await verify(parsed.chunks);
  assert.equal(v.valid, true);
  assert.equal(v.present, v.total - 1);
});

test("a corrupted length field is survived by re-finding the next sync word", () => {
  const damaged = loop.slice();
  const audioChunk = chunkOffsets(loop).find((c) => c.type === TYPE.AUDIO);
  damaged[audioChunk.offset + 10] ^= 0x7f; // length's third byte: points far past the end
  const parsed = parseLoop(damaged);
  assert.equal(parsed.audio, null);
  assert.equal(parsed.report.damaged, 1);
  assert.equal(parsed.frames.length, 180, "video before and after the bad chunk is intact");
});

test("a file cut short still plays the whole loop from what arrived", () => {
  const enhancementStart = chunkOffsets(loop).find((c) => c.type === TYPE.VIDEO && c.payload[2] === 1).offset;
  const cut = parseLoop(loop.subarray(0, enhancementStart + 100));
  assert.equal(cut.report.truncated, true);
  assert.deepEqual(cut.report.missingGops, []);
  assert.equal(cut.report.layersPresent, 1);
  assert.equal(cut.frames.length, 90, "every second frame across all six seconds");
  assert.ok(cut.audio);
});

test("a relay can drop the enhancement layer without decoding or re-signing", async () => {
  const trimmed = trimLayers(loop, 0);
  assert.ok(trimmed.length < loop.length * 0.6);
  const parsed = parseLoop(trimmed);
  assert.equal(parsed.frames.length, 90);
  assert.equal(parsed.frames[0].timestamp, 0);
  assert.equal(parsed.report.damaged, 0);
  const v = await verify(parsed.chunks);
  assert.equal(v.valid, true);
  assert.equal(v.present, v.total - 3);
  assert.equal(v.foreign, 0);
});

test("a tampered chunk with a recomputed checksum is caught by the signature", async () => {
  const chunks = readChunks(loop).chunks;
  const target = chunks.find((c) => c.type === TYPE.VIDEO);
  const forged = target.payload.slice();
  forged[30] ^= 1;
  const parts = [loop.subarray(0, target.offset), frameChunk(target.type, forged), loop.subarray(target.offset + target.raw.length)];
  const tampered = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    tampered.set(p, at);
    at += p.length;
  }
  const parsed = parseLoop(tampered);
  assert.equal(parsed.report.damaged, 0, "the CRC alone can't tell");
  const v = await verify(parsed.chunks);
  assert.equal(v.foreign, 1);
  assert.equal(v.present, v.total - 1);
});

test("foreign files and the standard CRC-32 check value", () => {
  assert.throws(() => parseLoop(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not an irl.ing v2 loop/);
  assert.equal((crc32(new TextEncoder().encode("123456789")) ^ 0xffffffff) >>> 0, 0xcbf43926);
});
