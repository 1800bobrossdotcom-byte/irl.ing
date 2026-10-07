import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { normalizePixels, normalizeMask } from "./mask.js";

const MODEL_SHA256 =
  "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8";
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
let session;
self.onmessage = async ({ data }) => {
  try {
    if (!session) {
      self.postMessage({
        type: "status",
        message: "Loading the cutout tool… First use downloads about 18 MB.",
      });
      const response = await fetch("/models/u2netp.onnx");
      if (!response.ok)
        throw new Error(
          "The cutout tool couldn’t load. Check your connection and try again.",
        );
      const bytes = await response.arrayBuffer();
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== MODEL_SHA256)
        throw new Error(
          "The cutout tool did not pass its integrity check. Please refresh and try again.",
        );
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    }
    self.postMessage({
      type: "status",
      message: "Finding your subject… Your photo stays on this device.",
    });
    const tensor = new ort.Tensor(
      "float32",
      normalizePixels(data.pixels),
      [1, 3, 320, 320],
    );
    const output = await session.run({ [session.inputNames[0]]: tensor });
    const mask = normalizeMask(output[session.outputNames[0]].data);
    tensor.dispose();
    for (const value of Object.values(output)) value.dispose();
    self.postMessage({ type: "result", mask }, [mask.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      message:
        error.message ||
        "Automatic cutout wasn’t available. You can still trace your object.",
    });
  }
};
