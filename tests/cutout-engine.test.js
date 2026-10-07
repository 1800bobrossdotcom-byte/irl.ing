import test from "node:test";
import assert from "node:assert/strict";
import { createCutoutEngine } from "../src/cutout-engine.js";

class FakeWorker {
  static instances = [];
  constructor(url, options) { this.url = url; this.options = options; this.messages = []; FakeWorker.instances.push(this); }
  postMessage(data, transfer) { this.messages.push({ data, transfer }); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage({ data }); }
}
const pixels = () => new Uint8ClampedArray(320 * 320 * 4);
const mask = () => new Uint8Array(320 * 320).fill(255);
const create = (options = {}) => createCutoutEngine({ WorkerClass: FakeWorker, ...options });
const latest = () => FakeWorker.instances.at(-1);

test("warmup and two photos share one worker, with request-specific statuses", async () => {
  const engine = create(), statuses = [];
  engine.warmup();
  const worker = latest(), warmup = worker.messages[0].data;
  engine.warmup();
  assert.equal(worker.messages.length, 1);
  const input = pixels(), first = engine.run(input, { onStatus: value => statuses.push(value) });
  const run = worker.messages[1].data;
  assert.deepEqual(worker.messages[1].transfer, [input.buffer]);
  worker.emit({ type: "status", id: warmup.id, message: "Loading" });
  worker.emit({ type: "ready", id: warmup.id });
  worker.emit({ type: "status", id: run.id, message: "Finding" });
  const firstMask = mask(); worker.emit({ type: "result", id: run.id, mask: firstMask });
  assert.equal(await first, firstMask);
  assert.deepEqual(statuses, ["Loading", "Finding"]);
  assert.equal(worker.terminated, undefined);
  const second = engine.run(pixels()), secondRequest = worker.messages[2].data;
  assert.equal(latest(), worker);
  worker.emit({ type: "result", id: run.id, mask: mask() }); // A duplicate old result cannot settle this photo.
  assert.notEqual(run.id, secondRequest.id);
  const secondMask = mask(); secondMask[0] = 17;
  worker.emit({ type: "result", id: secondRequest.id, mask: secondMask });
  assert.equal((await second)[0], 17);
  engine.dispose();
});

test("cancellation releases memory, rejects the active photo, and ignores old workers", async () => {
  const engine = create(), first = engine.run(pixels()), old = latest(), oldId = old.messages[0].data.id;
  const cancellation = assert.rejects(first, error => error.name === "AbortError");
  engine.cancel(); await cancellation;
  assert.equal(old.terminated, true);
  const next = engine.run(pixels()), current = latest(), id = current.messages[0].data.id;
  assert.notEqual(current, old);
  old.emit({ type: "result", id: oldId, mask: mask() });
  old.onerror();
  assert.equal(current.terminated, undefined);
  current.emit({ type: "result", id, mask: mask() });
  assert.equal((await next).length, 320 * 320);
  engine.dispose();
});

test("a second active photo is rejected without replacing the first", async () => {
  const engine = create(), first = engine.run(pixels()), worker = latest();
  await assert.rejects(engine.run(pixels()), /already being processed/);
  assert.equal(worker.messages.length, 1);
  worker.emit({ type: "result", id: worker.messages[0].data.id, mask: mask() });
  await first; engine.dispose();
});

test("failed initialization is silent during warmup and a photo retries with a fresh worker", async () => {
  const engine = create(); engine.warmup();
  const failed = latest();
  failed.emit({ type: "error", id: failed.messages[0].data.id, message: "Integrity check failed" });
  await Promise.resolve();
  assert.equal(failed.terminated, true);
  const photo = engine.run(pixels()), worker = latest();
  assert.notEqual(worker, failed);
  worker.emit({ type: "result", id: worker.messages[0].data.id, mask: mask() });
  await photo; engine.dispose();
});

test("incomplete masks fail clearly and release the worker", async () => {
  const engine = create(), photo = engine.run(pixels()), worker = latest();
  const failure = assert.rejects(photo, /incomplete mask/);
  worker.emit({ type: "result", id: worker.messages[0].data.id, mask: new Uint8Array(8) });
  await failure; assert.equal(worker.terminated, true); engine.dispose();
});

test("idle memory is bounded even when warmup never finishes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engine = create({ idleMs: 45 }); engine.warmup();
  const worker = latest();
  t.mock.timers.tick(44); assert.equal(worker.terminated, undefined);
  t.mock.timers.tick(1); assert.equal(worker.terminated, true);
  await Promise.resolve(); engine.dispose();
});

test("active inference uses its processing timeout rather than the warmup idle timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engine = create({ idleMs: 45 }); engine.warmup();
  const worker = latest(), photo = engine.run(pixels());
  const failure = assert.rejects(photo, /took too long/);
  t.mock.timers.tick(45); assert.equal(worker.terminated, undefined);
  t.mock.timers.tick(90000); await failure;
  assert.equal(worker.terminated, true); engine.dispose();
});

test("hidden pages release the active model and remove their listener when disposed", async () => {
  const previous = globalThis.document, listeners = new Map();
  globalThis.document = {
    hidden: false,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  const engine = create();
  try {
    const photo = engine.run(pixels()), worker = latest(), failure = assert.rejects(photo, error => error.name === "AbortError");
    globalThis.document.hidden = true; listeners.get("visibilitychange")();
    await failure; assert.equal(worker.terminated, true);
    engine.warmup(); assert.equal(latest(), worker);
    engine.dispose(); assert.equal(listeners.size, 0);
    await assert.rejects(engine.run(pixels()), /closed/);
  } finally { engine.dispose(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});
