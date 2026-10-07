import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { normalizePixels, normalizeMask } from "./mask.js";

const MODEL_SHA256 =
  "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8";
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
let session, initialization, queue = Promise.resolve();
async function initialize(id) {
  if (session) return session;
  if (!initialization) initialization = (async () => {
    self.postMessage({
      type: "status", id,
      message: "Getting the cutout tool ready…",
    });
    const response = await fetch("/models/u2netp.onnx");
    if (!response.ok)
      throw new Error("The cutout tool couldn’t load. Check your connection and try again.");
    const bytes = await response.arrayBuffer();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== MODEL_SHA256)
      throw new Error("The cutout tool did not pass its integrity check. Please refresh and try again.");
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    return session;
  })().catch(error => { initialization = null; throw error; });
  return initialization;
}

async function process(data) {
  const { id } = data;
  let tensor, output;
  try {
    if (!["warmup", "run"].includes(data.type)) throw new Error("Unknown cutout request.");
    if (data.type === "run" && (!(data.pixels instanceof Uint8ClampedArray || data.pixels instanceof Uint8Array) || data.pixels.length !== 320 * 320 * 4)) {
      throw new Error("The cutout tool needs a 320-pixel photo preview.");
    }
    await initialize(id);
    if (data.type === "warmup") { self.postMessage({ type: "ready", id }); return; }
    self.postMessage({
      type: "status", id,
      message: "Finding your subject… Your photo stays on this device.",
    });
    tensor = new ort.Tensor(
      "float32",
      normalizePixels(data.pixels),
      [1, 3, 320, 320],
    );
    output = await session.run({ [session.inputNames[0]]: tensor });
    const mask = normalizeMask(output[session.outputNames[0]].data);
    self.postMessage({ type: "result", id, mask }, [mask.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error", id,
      message:
        error.message ||
        "Automatic cutout wasn’t available. You can still trace your object.",
    });
  } finally {
    tensor?.dispose();
    if (output) for (const value of Object.values(output)) value.dispose();
  }
}
self.onmessage = ({ data }) => {
  // Warmup and inference share one verified session; ONNX runs never overlap.
  queue = queue.then(() => process(data)).catch(error => {
    self.postMessage({ type: "error", id: data.id, message: error.message || "Automatic cutout could not finish." });
  });
};
